def _make_computer():
    import re

    def _encode_arg(value):
        if isinstance(value, re.Pattern):
            if not isinstance(value.pattern, str):
                raise TypeError("computer helpers require regular expressions with string patterns")
            flags = ""
            if value.flags & re.IGNORECASE:
                flags += "i"
            if value.flags & re.MULTILINE:
                flags += "m"
            if value.flags & re.DOTALL:
                flags += "s"
            return {"__omp_re": {"source": value.pattern, "flags": flags}}
        return value

    def _arguments(args, kwargs):
        values = list(args)
        while values and values[-1] is None:
            values.pop()
        values = [_encode_arg(value) for value in values]
        options = {
            key: _encode_arg(value)
            for key, value in kwargs.items()
            if value is not None
        }
        if options:
            values.append(options)
        return values

    async def _invoke(action, options):
        response = await _omp_prelude(
            "computer",
            {
                **{
                    key: value
                    for key, value in options.items()
                    if value is not None
                },
                "action": action,
            },
        )
        if isinstance(response, str):
            return {}
        if not isinstance(response, dict):
            raise RuntimeError("computer returned an invalid response")
        text = response.get("text")
        if isinstance(text, str) and text:
            print(text)
        details = response.get("details")
        return details if isinstance(details, dict) else {}

    async def _call(chain):
        details = await _invoke("call", {"chain": chain})
        return details.get("value")

    def _step(method, args, kwargs):
        return {"method": method, "args": _arguments(args, kwargs)}


    class _Element:
        __slots__ = ("ref", "role", "nativeRole", "title", "description", "enabled", "focused", "childCount")

        def __init__(self, snapshot):
            for field in self.__slots__:
                setattr(self, field, snapshot.get(field))

        def __repr__(self):
            return f"<computer.Element ref={self.ref!r} role={self.role!r}>"

        async def _method(self, method, args, kwargs):
            return await _call([_step("ref", (self.ref,), {}), _step(method, args, kwargs)])

        async def value(self, *args, **kwargs):
            return await self._method("value", args, kwargs)

        async def setValue(self, *args, **kwargs):
            return await self._method("setValue", args, kwargs)

        async def bounds(self, *args, **kwargs):
            return await self._method("bounds", args, kwargs)

        async def attributes(self, *args, **kwargs):
            return await self._method("attributes", args, kwargs)

        async def actions(self, *args, **kwargs):
            return await self._method("actions", args, kwargs)

        async def perform(self, *args, **kwargs):
            return await self._method("perform", args, kwargs)

        async def press(self, *args, **kwargs):
            return await self._method("press", args, kwargs)

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

        async def focus(self, *args, **kwargs):
            return await self._method("focus", args, kwargs)

        async def parent(self):
            snapshot = await self._method("parent", (), {})
            return _Element(snapshot) if isinstance(snapshot, dict) else None

        async def children(self):
            return [_Element(snapshot) for snapshot in await self._method("children", (), {})]

    class _Window:
        __slots__ = ("id", "app", "title", "pid", "bounds", "positionKnown", "focused")

        def __init__(self, snapshot):
            for field in self.__slots__:
                setattr(self, field, snapshot.get(field))

        def __repr__(self):
            return f"<computer.Window id={self.id!r} app={self.app!r}>"

        async def _method(self, method, args, kwargs):
            return await _call([_step("window", (self.id,), {}), _step(method, args, kwargs)])

        async def screenshot(self, *args, **kwargs):
            return await self._method("screenshot", args, kwargs)

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

        async def doubleClick(self, *args, **kwargs):
            return await self._method("doubleClick", args, kwargs)

        async def move(self, *args, **kwargs):
            return await self._method("move", args, kwargs)

        async def drag(self, *args, **kwargs):
            return await self._method("drag", args, kwargs)

        async def scroll(self, *args, **kwargs):
            return await self._method("scroll", args, kwargs)

        async def type(self, *args, **kwargs):
            return await self._method("type", args, kwargs)

        async def press(self, *args, **kwargs):
            return await self._method("press", args, kwargs)

        async def state(self, *args, **kwargs):
            """Fresh window state; the handle fields stay a resolution-time snapshot."""
            return await self._method("state", args, kwargs)

        async def focus(self, *args, **kwargs):
            """Activate this window; the only activation helper."""
            return await self._method("focus", args, kwargs)

        async def close(self, *args, **kwargs):
            """Request close of this one window; the desktop session stays alive."""
            return await self._method("close", args, kwargs)

        async def moveTo(self, *args, **kwargs):
            """Move the window in `capabilities().windowControl.coordinateSpace`."""
            return await self._method("moveTo", args, kwargs)

        async def moveBy(self, *args, **kwargs):
            """Move the window itself by a relative offset."""
            return await self._method("moveBy", args, kwargs)

        async def resize(self, *args, **kwargs):
            """Give at least one axis; the other axis keeps its current size."""
            return await self._method("resize", args, kwargs)

        async def maximize(self, *args, **kwargs):
            return await self._method("maximize", args, kwargs)

        async def minimize(self, *args, **kwargs):
            """Backends without it refuse the call; read `state()` for the outcome."""
            return await self._method("minimize", args, kwargs)

        async def restore(self, *args, **kwargs):
            return await self._method("restore", args, kwargs)

        async def toggleMaximized(self, *args, **kwargs):
            """Non-idempotent toggle; confirm with a screenshot and never retry blindly."""
            return await self._method("toggleMaximized", args, kwargs)

        async def toggleFullscreen(self, *args, **kwargs):
            """Non-idempotent toggle; confirm with a screenshot and never retry blindly."""
            return await self._method("toggleFullscreen", args, kwargs)

        async def toggleWindowedFullscreen(self, *args, **kwargs):
            """Non-idempotent toggle; confirm with a screenshot and never retry blindly."""
            return await self._method("toggleWindowedFullscreen", args, kwargs)

        async def setFullscreen(self, *args, **kwargs):
            """Idempotent setter, unlike the toggle helpers."""
            return await self._method("setFullscreen", args, kwargs)

        async def setFloating(self, *args, **kwargs):
            """Idempotent setter, unlike the toggle helpers."""
            return await self._method("setFloating", args, kwargs)

        async def center(self, *args, **kwargs):
            return await self._method("center", args, kwargs)

        async def moveToWorkspace(self, *args, **kwargs):
            """Move to an exact `computer.workspaces()` id; `focus` defaults to false."""
            return await self._method("moveToWorkspace", args, kwargs)

        async def moveToDisplay(self, *args, **kwargs):
            """Move to an exact `computer.displays()` id; no focus-on-move option exists."""
            return await self._method("moveToDisplay", args, kwargs)

        async def ax(self, *args, **kwargs):
            return await self._method("ax", args, kwargs)

        async def find(self, *args, **kwargs):
            return [_Element(snapshot) for snapshot in await self._method("find", args, kwargs)]

        async def ref(self, ref):
            """Resolve a live accessibility element by its `[ref=eN]` tag."""
            snapshot = await _call([_step("ref", (ref,), {})])
            return _Element(snapshot) if isinstance(snapshot, dict) else None

    class _Clipboard:
        __slots__ = ()

        async def read(self):
            return await _call([_step("clipboard.read", (), {})])

        async def write(self, text):
            return await _call([_step("clipboard.write", (text,), {})])

    class _Computer:
        __slots__ = ("clipboard",)

        def __init__(self):
            self.clipboard = _Clipboard()

        def __repr__(self):
            return "<computer>"

        async def _method(self, method, args, kwargs):
            return await _call([_step(method, args, kwargs)])

        async def displays(self, *args, **kwargs):
            return await self._method("displays", args, kwargs)

        async def windows(self, *args, **kwargs):
            return await self._method("windows", args, kwargs)

        async def workspaces(self, *args, **kwargs):
            """List workspaces; their exact ids are the only accepted focus and move targets."""
            return await self._method("workspaces", args, kwargs)

        async def focusWorkspace(self, *args, **kwargs):
            return await self._method("focusWorkspace", args, kwargs)

        async def focusDisplay(self, *args, **kwargs):
            return await self._method("focusDisplay", args, kwargs)

        async def moveWorkspaceToDisplay(self, *args, **kwargs):
            return await self._method("moveWorkspaceToDisplay", args, kwargs)

        async def screenshot(self, *args, **kwargs):
            return await self._method("screenshot", args, kwargs)

        async def click(self, *args, **kwargs):
            return await self._method("click", args, kwargs)

        async def doubleClick(self, *args, **kwargs):
            return await self._method("doubleClick", args, kwargs)

        async def move(self, *args, **kwargs):
            return await self._method("move", args, kwargs)

        async def drag(self, *args, **kwargs):
            return await self._method("drag", args, kwargs)

        async def scroll(self, *args, **kwargs):
            return await self._method("scroll", args, kwargs)

        async def type(self, *args, **kwargs):
            return await self._method("type", args, kwargs)

        async def press(self, *args, **kwargs):
            return await self._method("press", args, kwargs)

        async def window(self, *args, **kwargs):
            """Resolve one window by id ("74" or 74) or by `app`/`title` filter keywords."""
            snapshot = await self._method("window", args, kwargs)
            return _Window(snapshot) if isinstance(snapshot, dict) else None

        async def focusedWindow(self):
            snapshot = await self._method("focusedWindow", (), {})
            return _Window(snapshot) if isinstance(snapshot, dict) else None

        async def elementAt(self, x, y):
            snapshot = await self._method("elementAt", (x, y), {})
            return _Element(snapshot) if isinstance(snapshot, dict) else None

        async def focusedElement(self):
            snapshot = await self._method("focusedElement", (), {})
            return _Element(snapshot) if isinstance(snapshot, dict) else None

        async def ref(self, ref):
            """Resolve a live accessibility element by its `[ref=eN]` tag."""
            snapshot = await self._method("ref", (ref,), {})
            return _Element(snapshot) if isinstance(snapshot, dict) else None

        async def run(self, code, *, read_only=None, timeout=None):
            """Run a JavaScript code string in the persistent desktop session and return its value."""
            if not isinstance(code, str):
                raise TypeError("computer.run() expects a JavaScript code string")
            details = await _invoke(
                "run",
                {"code": code, "read_only": read_only, "timeout": timeout},
            )
            return details.get("value")

        async def capabilities(self):
            """Return native backend capabilities and permission state, or None when unavailable."""
            details = await _invoke("capabilities", {})
            return details if "backend" in details else None

        async def close(self):
            """End the persistent desktop session; later calls fail. A window's close() does not."""
            await _invoke("close", {})

    return _Computer()


computer = _make_computer()
del _make_computer
