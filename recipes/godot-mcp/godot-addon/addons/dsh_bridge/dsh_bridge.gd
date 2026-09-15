@tool
extends EditorPlugin
## DSH Bridge —— 让 AI 代理（DSH）能操作你**正在编辑**的场景。
##
## 只监听 127.0.0.1，且除 /ping 外都要求 X-DSH-Token 头（token 写在 user://dsh_bridge_token.txt，
## 由本插件首次运行时随机生成）。所有改动都走 EditorUndoRedoManager，所以编辑器里可以 Ctrl+Z 撤销。
##
## 端点：
##   GET  /ping              心跳 + 项目/版本/是否在运行
##   GET  /scene?depth=N     当前编辑场景的节点树
##   GET  /selection         当前选中的节点与常用属性
##   POST /node/add          {parent, type, name}
##   POST /node/set          {path, property, value}
##   POST /node/delete       {path}
##   POST /scene/save        保存当前场景到磁盘
##   POST /play              /stop
##   POST /reload            重新扫描文件系统

# Port range. Overridable from the environment without touching the plugin:
#   DSH_GODOT_BRIDGE_PORT       first port to try     (default 9080)
#   DSH_GODOT_BRIDGE_PORT_END   last port to try      (default start + 10)
# The MCP side reads the port this plugin actually bound from PORT_PATH, so the two
# ends never have to agree on a number in advance -- which is the whole point: a
# fixed port WILL eventually be taken by some unrelated service.
const PORT_RANGE_DEFAULT_START := 9080
const PORT_RANGE_SPAN := 10
const BIND_ADDR := "127.0.0.1"
const TOKEN_PATH := "user://dsh_bridge_token.txt"
const PORT_PATH := "user://dsh_bridge_port.txt"
const MAX_BODY := 4 * 1024 * 1024

static func _env_int(name: String, fallback: int) -> int:
	var raw := OS.get_environment(name)
	if raw == "":
		return fallback
	if not raw.is_valid_int():
		printerr("[dsh_bridge] env %s is not an integer (%s); using %d" % [name, raw, fallback])
		return fallback
	return int(raw)

var _server: TCPServer = null
var _token := ""
var _port := 0
var _buffers := {}   # StreamPeerTCP -> String（累积的请求文本）

func _enter_tree() -> void:
	_token = _load_token()
	_server = TCPServer.new()
	var range_start := _env_int("DSH_GODOT_BRIDGE_PORT", PORT_RANGE_DEFAULT_START)
	var range_end := _env_int("DSH_GODOT_BRIDGE_PORT_END", range_start + PORT_RANGE_SPAN)
	# 端口范围内自动挑一个空闲的：避免上一个编辑器实例的僵尸占用让整条链路失效
	for candidate in range(range_start, range_end + 1):
		if _server.listen(candidate, BIND_ADDR) == OK:
			_port = candidate
			break
	if _port == 0:
		printerr("[dsh_bridge] no free port in %d-%d -- bridge NOT started. Free one, or set DSH_GODOT_BRIDGE_PORT / DSH_GODOT_BRIDGE_PORT_END to a free range." % [range_start, range_end])
		_server = null
		return
	var pf := FileAccess.open(PORT_PATH, FileAccess.WRITE)
	if pf != null:
		pf.store_string(str(_port))
	print("[dsh_bridge] 已监听 http://%s:%d（token 见 %s）" % [BIND_ADDR, _port, TOKEN_PATH])
	set_process(true)

func _exit_tree() -> void:
	if _server != null:
		_server.stop()
		_server = null
	for peer in _buffers.keys():
		var p := peer as StreamPeerTCP
		if p != null:
			p.disconnect_from_host()
	_buffers.clear()
	print("[dsh_bridge] 已停止")

func _load_token() -> String:
	if FileAccess.file_exists(TOKEN_PATH):
		var f := FileAccess.open(TOKEN_PATH, FileAccess.READ)
		if f != null:
			var t := f.get_as_text().strip_edges()
			if t.length() >= 16:
				return t
	var crypto := Crypto.new()
	var token := crypto.generate_random_bytes(24).hex_encode()
	var w := FileAccess.open(TOKEN_PATH, FileAccess.WRITE)
	if w != null:
		w.store_string(token)
	return token

func _process(_delta: float) -> void:
	if _server == null:
		return
	while _server.is_connection_available():
		var peer := _server.take_connection()
		if peer != null:
			_buffers[peer] = ""
	var finished: Array = []
	for peer in _buffers.keys():
		var p := peer as StreamPeerTCP
		if p == null:
			finished.append(peer)
			continue
		p.poll()
		var available := p.get_available_bytes()
		if available > 0:
			var res: Array = p.get_partial_data(available)
			if res[0] == OK:
				_buffers[p] = str(_buffers[p]) + (res[1] as PackedByteArray).get_string_from_utf8()
		var text: String = str(_buffers[p])
		if text.length() > MAX_BODY:
			_send(p, 413, { "error": "request too large" })
			finished.append(peer)
			continue
		var sep := text.find("\r\n\r\n")
		if sep >= 0:
			var head := text.substr(0, sep)
			var body := text.substr(sep + 4)
			var need := _content_length(head)
			if body.to_utf8_buffer().size() >= need:
				var clipped := body.to_utf8_buffer().slice(0, need).get_string_from_utf8()
				_handle(p, head, clipped)
				finished.append(peer)
		elif p.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			finished.append(peer)
	for peer in finished:
		_buffers.erase(peer)
		var p := peer as StreamPeerTCP
		if p != null:
			p.disconnect_from_host()

func _content_length(head: String) -> int:
	for line in head.split("\r\n"):
		if line.to_lower().begins_with("content-length:"):
			return int(line.split(":", true, 1)[1].strip_edges())
	return 0

func _handle(peer: StreamPeerTCP, head: String, body: String) -> void:
	var lines := head.split("\r\n")
	if lines.size() == 0:
		_send(peer, 400, { "error": "malformed request" })
		return
	var parts := lines[0].split(" ")
	var method := parts[0] if parts.size() > 0 else "GET"
	var url := parts[1] if parts.size() > 1 else "/"
	var headers := {}
	for i in range(1, lines.size()):
		var kv := lines[i].split(":", true, 1)
		if kv.size() == 2:
			headers[kv[0].strip_edges().to_lower()] = kv[1].strip_edges()

	var path := url
	var query := ""
	var q := url.find("?")
	if q >= 0:
		path = url.substr(0, q)
		query = url.substr(q + 1)

	if path != "/ping" and str(headers.get("x-dsh-token", "")) != _token:
		_send(peer, 403, { "error": "缺少或错误的 X-DSH-Token" })
		return

	var payload := {}
	if body.strip_edges() != "":
		var parsed: Variant = JSON.parse_string(body)
		if parsed is Dictionary:
			payload = parsed

	var result: Variant = _route(method, path, query, payload)
	if result is Dictionary and result.has("__status"):
		_send(peer, int(result["__status"]), result)
	else:
		_send(peer, 200, result)

func _send(peer: StreamPeerTCP, status: int, data: Variant) -> void:
	var body := JSON.stringify(data, "  ")
	var bytes := body.to_utf8_buffer()
	var reasons := { 200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 413: "Payload Too Large", 500: "Internal Server Error" }
	var reason: String = reasons.get(status, "OK")
	var head := "HTTP/1.1 %d %s\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % [status, reason, bytes.size()]
	peer.put_data(head.to_utf8_buffer())
	peer.put_data(bytes)

# ---------------------------------------------------------------- 路由

func _route(method: String, path: String, query: String, payload: Dictionary) -> Variant:
	match path:
		"/ping":
			return {
				"ok": true,
				"godot": Engine.get_version_info().string,
				"project": ProjectSettings.globalize_path("res://"),
				"projectName": ProjectSettings.get_setting("application/config/name", ""),
				"playing": EditorInterface.is_playing_scene(),
				"editedScene": _edited_scene_path(),
			}
		"/scene":
			return _scene_tree(int(_query_value(query, "depth", "4")))
		"/selection":
			return _selection()
		"/node/add":
			return _node_add(payload)
		"/node/set":
			return _node_set(payload)
		"/node/delete":
			return _node_delete(payload)
		"/scene/save":
			return _scene_save()
		"/play":
			EditorInterface.play_main_scene()
			return { "ok": true, "playing": true }
		"/stop":
			EditorInterface.stop_playing_scene()
			return { "ok": true, "playing": false }
		"/reload":
			EditorInterface.get_resource_filesystem().scan()
			return { "ok": true, "rescanned": true }
	return { "__status": 404, "error": "unknown endpoint: " + path, "method": method }

func _query_value(query: String, key: String, fallback: String) -> String:
	for pair in query.split("&"):
		var kv := pair.split("=", true, 1)
		if kv.size() == 2 and kv[0] == key:
			return kv[1]
	return fallback

func _edited_scene_path() -> String:
	var root := EditorInterface.get_edited_scene_root()
	return root.scene_file_path if root != null else ""

func _find_node(path: String) -> Node:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return null
	if path == "." or path == "" or path == str(root.name):
		return root
	return root.get_node_or_null(NodePath(path))

func _rel_path(node: Node) -> String:
	var root := EditorInterface.get_edited_scene_root()
	if root == null or node == root:
		return "."
	return str(root.get_path_to(node))

func _scene_tree(max_depth: int) -> Variant:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return { "__status": 400, "error": "编辑器里没有打开的场景" }
	return { "scenePath": root.scene_file_path, "root": _node_info(root, 0, max_depth) }

func _node_info(node: Node, depth: int, max_depth: int) -> Dictionary:
	var info := { "name": str(node.name), "type": node.get_class(), "path": _rel_path(node) }
	if node is CanvasItem:
		info["visible"] = (node as CanvasItem).visible
	if node is Control:
		var c := node as Control
		info["rect"] = [c.position.x, c.position.y, c.size.x, c.size.y]
	if node.get_script() != null:
		info["script"] = (node.get_script() as Script).resource_path
	if depth < max_depth:
		var kids: Array = []
		for child in node.get_children():
			kids.append(_node_info(child, depth + 1, max_depth))
		if kids.size() > 0:
			info["children"] = kids
	return info

func _selection() -> Variant:
	var nodes := EditorInterface.get_selection().get_selected_nodes()
	var out: Array = []
	var props := ["position", "size", "rotation", "scale", "modulate", "self_modulate", "visible", "text", "texture", "script", "z_index", "color"]
	for node in nodes:
		var entry := { "path": _rel_path(node), "type": node.get_class(), "properties": {} }
		for prop in props:
			if prop in node:
				var value: Variant = node.get(prop)
				if value is Resource:
					entry["properties"][prop] = (value as Resource).resource_path
				elif value is Color:
					entry["properties"][prop] = "#" + (value as Color).to_html()
				elif value is Vector2 or value is Vector2i:
					entry["properties"][prop] = [value.x, value.y]
				else:
					entry["properties"][prop] = value
		out.append(entry)
	return { "count": out.size(), "nodes": out }

func _coerce(current: Variant, value: Variant) -> Variant:
	if current is Vector2:
		if value is Array and (value as Array).size() >= 2:
			return Vector2(float(value[0]), float(value[1]))
		if value is Dictionary:
			return Vector2(float(value.get("x", 0)), float(value.get("y", 0)))
	if current is Vector2i:
		if value is Array and (value as Array).size() >= 2:
			return Vector2i(int(value[0]), int(value[1]))
	if current is Color:
		if value is String:
			return Color(str(value))
		if value is Array and (value as Array).size() >= 3:
			var a := float(value[3]) if (value as Array).size() > 3 else 1.0
			return Color(float(value[0]), float(value[1]), float(value[2]), a)
	if current is float:
		return float(value)
	if current is int:
		return int(value)
	if current is bool:
		return bool(value)
	if current is String:
		return str(value)
	if current is NodePath:
		return NodePath(str(value))
	return value

func _node_add(payload: Dictionary) -> Variant:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return { "__status": 400, "error": "编辑器里没有打开的场景" }
	var parent_path := str(payload.get("parent", "."))
	var parent: Node = root if parent_path == "." or parent_path == "" else root.get_node_or_null(NodePath(parent_path))
	if parent == null:
		return { "__status": 400, "error": "找不到父节点: " + parent_path }
	var type_name := str(payload.get("type", "Node2D"))
	if not ClassDB.class_exists(type_name):
		return { "__status": 400, "error": "未知的节点类型: " + type_name }
	var node: Node = ClassDB.instantiate(type_name)
	if node == null:
		return { "__status": 400, "error": "无法实例化: " + type_name }
	if payload.has("name"):
		node.name = str(payload["name"])
	var undo := get_undo_redo()
	undo.create_action("DSH: 添加节点 %s" % node.name)
	undo.add_do_method(parent, "add_child", node)
	undo.add_do_method(node, "set_owner", root)
	undo.add_do_reference(node)
	undo.add_undo_method(parent, "remove_child", node)
	undo.commit_action()
	return { "ok": true, "added": _rel_path(node), "type": type_name, "parent": parent_path, "撤销": "编辑器里 Ctrl+Z 可撤销" }

func _node_set(payload: Dictionary) -> Variant:
	if not payload.has("path") or not payload.has("property"):
		return { "__status": 400, "error": "需要 path 与 property" }
	var node := _find_node(str(payload["path"]))
	if node == null:
		return { "__status": 400, "error": "找不到节点: " + str(payload["path"]) }
	var prop := str(payload["property"])
	if not (prop in node):
		return { "__status": 400, "error": "节点没有该属性: " + prop, "提示": "属性名区分大小写，用 /selection 或 /scene 先看一下" }
	var old_value: Variant = node.get(prop)
	var new_value := _coerce(old_value, payload.get("value"))
	var undo := get_undo_redo()
	undo.create_action("DSH: 设置 %s.%s" % [node.name, prop])
	undo.add_do_property(node, prop, new_value)
	undo.add_undo_property(node, prop, old_value)
	undo.commit_action()
	var applied: Variant = node.get(prop)
	var shown: Variant = applied
	if applied is Color:
		shown = "#" + (applied as Color).to_html()
	elif applied is Vector2 or applied is Vector2i:
		shown = [applied.x, applied.y]
	elif applied is Resource:
		shown = (applied as Resource).resource_path
	return { "ok": true, "node": _rel_path(node), "property": prop, "value": shown }

func _node_delete(payload: Dictionary) -> Variant:
	if not payload.has("path"):
		return { "__status": 400, "error": "需要 path" }
	var root := EditorInterface.get_edited_scene_root()
	var node := _find_node(str(payload["path"]))
	if node == null or node == root:
		return { "__status": 400, "error": "找不到节点，或试图删除场景根节点" }
	var parent := node.get_parent()
	var undo := get_undo_redo()
	undo.create_action("DSH: 删除节点 %s" % node.name)
	undo.add_do_method(parent, "remove_child", node)
	undo.add_undo_method(parent, "add_child", node)
	undo.add_undo_method(node, "set_owner", root)
	undo.add_undo_method(node, "set_name", node.name)
	undo.commit_action()
	return { "ok": true, "deleted": str(payload["path"]) }

func _scene_save() -> Variant:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return { "__status": 400, "error": "编辑器里没有打开的场景" }
	var path := root.scene_file_path
	if path == "" or path == null:
		return { "__status": 400, "error": "该场景还没有保存过（没有文件路径），请先在编辑器里另存为" }
	var packed := PackedScene.new()
	var err := packed.pack(root)
	if err != OK:
		return { "__status": 500, "error": "打包场景失败（错误码 %d）" % err }
	err = ResourceSaver.save(packed, path)
	if err != OK:
		return { "__status": 500, "error": "保存失败（错误码 %d）" % err }
	EditorInterface.get_resource_filesystem().scan()
	return { "ok": true, "saved": path }
