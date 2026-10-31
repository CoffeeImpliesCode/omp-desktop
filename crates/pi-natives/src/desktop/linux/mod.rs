pub mod ax;
mod menus;
pub mod wayland;
pub mod x11;

use std::{io, os::fd::RawFd, path::Path};

use super::{
	backend::Backend,
	error::{CoreResult, DesktopError},
	types::DisplaySelector,
};

pub fn new_backend(display: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	match wayland_endpoint() {
		// Reachable and Blocked both keep the session on Wayland. A compositor
		// this process may not judge is not a dead compositor, and the fallback it
		// would trigger is worse than the failure it avoids: niri's Xwayland root
		// window is empty, so nothing can be focused there.
		WaylandEndpoint::Reachable | WaylandEndpoint::Blocked => {
			Ok(Box::new(wayland::WaylandBackend::new(display)))
		},
		WaylandEndpoint::Stale => {
			if std::env::var_os("DISPLAY").is_some() {
				Ok(Box::new(x11::X11Backend::new(display)?))
			} else {
				Err(DesktopError::capture_failed(
					"no display server (no reachable Wayland socket and DISPLAY is not set)",
				))
			}
		},
	}
}

/// What the Wayland environment points at.
///
/// Only [`WaylandEndpoint::Stale`] may fall through to X11.
enum WaylandEndpoint {
	/// A compositor socket took the probe connection.
	Reachable,
	/// A socket is configured but this process cannot tell whether it answers.
	Blocked,
	/// Nothing is there: no socket name, a stale name, an orphaned socket inode,
	/// or a path that is not a socket at all.
	Stale,
}

/// What an inherited `WAYLAND_SOCKET` descriptor turned out to be.
enum InheritedSocket {
	/// A live compositor socket.
	Live,
	/// Closed, not a Unix stream, or not connected. The socket path decides
	/// instead.
	Invalid,
	/// This process may not judge it.
	Unjudged,
}

fn wayland_endpoint() -> WaylandEndpoint {
	match inherited_socket() {
		InheritedSocket::Live => return WaylandEndpoint::Reachable,
		InheritedSocket::Unjudged => return WaylandEndpoint::Blocked,
		// A descriptor that is not a compositor socket leaves the path to decide.
		InheritedSocket::Invalid => {},
	}
	let Some(display) = std::env::var_os("WAYLAND_DISPLAY").filter(|display| !display.is_empty())
	else {
		return WaylandEndpoint::Stale;
	};
	let display = Path::new(&display);
	if display.is_absolute() {
		return probe_compositor(display);
	}
	// A relative name is the socket file inside the runtime directory, which is
	// where compositors put it.
	let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR") else {
		return WaylandEndpoint::Stale;
	};
	probe_compositor(&Path::new(&runtime_dir).join(display))
}

/// Checks a connected Unix stream without changing descriptor flags or
/// consuming protocol bytes. An idle live peer need not send data first.
fn inherited_socket() -> InheritedSocket {
	let Some(value) = std::env::var_os("WAYLAND_SOCKET") else {
		return InheritedSocket::Invalid;
	};
	// libwayland parses the value as a whole-string integer and refuses
	// descriptors that are not open.
	let Some(fd) = value
		.to_str()
		.and_then(|value| value.parse::<libc::c_int>().ok())
	else {
		return InheritedSocket::Invalid;
	};
	if fd < 0 {
		return InheritedSocket::Invalid;
	}
	match socket_type(fd) {
		Ok(libc::SOCK_STREAM) => {},
		Ok(_) => return InheritedSocket::Invalid,
		Err(code) if is_conclusive(code) => return InheritedSocket::Invalid,
		Err(_) => return InheritedSocket::Unjudged,
	}
	match peer_family(fd) {
		Ok(family) if i32::from(family) == libc::AF_UNIX => {},
		// A socket with no connected peer is not a compositor socket.
		Ok(_) | Err(libc::ENOTCONN) => return InheritedSocket::Invalid,
		Err(code) if is_conclusive(code) => return InheritedSocket::Invalid,
		Err(_) => return InheritedSocket::Unjudged,
	}
	match peer_is_live(fd) {
		Ok(true) => InheritedSocket::Live,
		Ok(false) => InheritedSocket::Invalid,
		Err(code) if is_conclusive(code) => InheritedSocket::Invalid,
		Err(_) => InheritedSocket::Unjudged,
	}
}

/// Only conclusive descriptor failures permit falling through to the path.
const fn is_conclusive(code: libc::c_int) -> bool {
	matches!(code, libc::EBADF | libc::ENOTSOCK | libc::EINVAL | libc::ENOTCONN | libc::ECONNRESET)
}

/// The socket type, or the `errno` that hid it.
fn socket_type(fd: RawFd) -> Result<libc::c_int, libc::c_int> {
	let mut kind: libc::c_int = 0;
	let mut length =
		libc::socklen_t::try_from(std::mem::size_of::<libc::c_int>()).expect("c_int fits socklen_t");
	// SAFETY: `kind` and `length` describe the buffer `getsockopt` fills, and `fd`
	// is the caller's descriptor.
	if unsafe {
		libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_TYPE, (&raw mut kind).cast(), &mut length)
	} != 0
	{
		return Err(last_errno());
	}
	Ok(kind)
}

/// The family of the connected peer, or the `errno` that hid it. A socket with
/// no peer reports `ENOTCONN`.
fn peer_family(fd: RawFd) -> Result<libc::sa_family_t, libc::c_int> {
	let mut address = std::mem::MaybeUninit::<libc::sockaddr_storage>::uninit();
	let mut length = libc::socklen_t::try_from(std::mem::size_of::<libc::sockaddr_storage>())
		.expect("sockaddr_storage fits socklen_t");
	// SAFETY: `address` and `length` describe the buffer `getpeername` fills, and
	// `fd` is the caller's descriptor.
	if unsafe { libc::getpeername(fd, address.as_mut_ptr().cast(), &mut length) } != 0 {
		return Err(last_errno());
	}
	// SAFETY: a successful getpeername initializes ss_family, but need not
	// initialize the rest of sockaddr_storage. Read only that field.
	Ok(unsafe { std::ptr::addr_of!((*address.as_ptr()).ss_family).read() })
}

/// Zero-time readiness check; never consumes bytes or changes descriptor flags.
fn peer_is_live(fd: RawFd) -> Result<bool, libc::c_int> {
	let mut pollfd = libc::pollfd { fd, events: libc::POLLRDHUP, revents: 0 };
	// SAFETY: pollfd is initialized and borrowed only for this syscall.
	if unsafe { libc::poll(&mut pollfd, 1, 0) } < 0 {
		return Err(last_errno());
	}
	Ok(pollfd.revents & (libc::POLLRDHUP | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) == 0)
}

fn last_errno() -> libc::c_int {
	io::Error::last_os_error()
		.raw_os_error()
		.unwrap_or(libc::EIO)
}

/// Judges `path` by connecting to it once, then dropping that connection
/// without sending a byte: selection must not consume a compositor connection
/// slot or start a compositor handshake.
fn probe_compositor(path: &Path) -> WaylandEndpoint {
	let Some(address) = SocketAddress::new(path) else {
		return WaylandEndpoint::Stale;
	};
	// SAFETY: a fresh AF_UNIX socket that this call owns until the close below.
	let fd = unsafe {
		libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC, 0)
	};
	if fd < 0 {
		// No descriptor to probe with, which says nothing about the compositor.
		return WaylandEndpoint::Blocked;
	}
	// SAFETY: `fd` is an AF_UNIX socket and `address` describes a NUL-terminated
	// path inside the struct.
	let endpoint = if unsafe { libc::connect(fd, address.as_ptr(), address.length) } == 0 {
		WaylandEndpoint::Reachable
	} else {
		// SAFETY: `connect` set `errno` for the failure above.
		match io::Error::last_os_error().raw_os_error() {
			// Nothing is listening, nothing is there, or the path is not a socket.
			Some(code) if is_absent(code) => WaylandEndpoint::Stale,
			// A full backlog means a live but busy compositor, and a permission or
			// resource failure says nothing about it at all. Neither is staleness.
			_ => WaylandEndpoint::Blocked,
		}
	};
	// SAFETY: `fd` came from `socket` above and is used nowhere after this.
	unsafe { libc::close(fd) };
	endpoint
}

/// Whether `errno` proves no compositor socket is there, as opposed to refusing
/// to say.
const fn is_absent(code: libc::c_int) -> bool {
	matches!(
		code,
		libc::ENOENT
			| libc::ENOTDIR
			| libc::ECONNREFUSED
			| libc::ENOTSOCK
			| libc::ENAMETOOLONG
			| libc::ELOOP
			| libc::EROFS
	)
}

/// One `sockaddr_un` describing a compositor socket path.
struct SocketAddress {
	address: libc::sockaddr_un,
	length:  libc::socklen_t,
}

impl SocketAddress {
	/// `None` when the path cannot be a Unix socket address: empty, or longer
	/// than `sun_path` holds. No compositor exports such a path, so the caller
	/// may read it as nothing being there.
	fn new(path: &Path) -> Option<Self> {
		// SAFETY: a zeroed `sockaddr_un` is a valid value, a zero `sa_family_t`
		// followed by a zeroed `sun_path` array.
		let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
		let bytes = path.as_os_str().as_encoded_bytes();
		if bytes.is_empty() || bytes.len() + 1 > address.sun_path.len() {
			return None;
		}
		address.sun_family = libc::AF_UNIX as libc::sa_family_t;
		// SAFETY: `sun_path` has room for `bytes` plus the zeroed terminator, which
		// is how `connect` sees where the path ends.
		unsafe {
			std::ptr::copy_nonoverlapping(
				bytes.as_ptr(),
				address.sun_path.as_mut_ptr().cast::<u8>(),
				bytes.len(),
			);
		}
		let length =
			libc::socklen_t::try_from(std::mem::size_of::<libc::sa_family_t>() + bytes.len() + 1)
				.ok()?;
		Some(Self { address, length })
	}

	const fn as_ptr(&self) -> *const libc::sockaddr {
		std::ptr::from_ref(&self.address).cast()
	}
}

/// Backend selection under test.
///
/// `new_backend` reads the process environment, so every case runs it in a
/// child process with a fixture-only environment: no test mutates process
/// environment, opens a session bus, portal, or real compositor socket, and
/// keeps its own sockets in a private directory, so cases stay independent.
#[cfg(test)]
mod backend_selection_tests {
	use std::{
		ffi::OsString,
		fs::{self, File},
		io::{Read as _, Write as _},
		net::{TcpListener, TcpStream},
		os::{
			fd::{AsRawFd as _, RawFd},
			unix::{
				fs::{FileTypeExt as _, PermissionsExt as _},
				net::{UnixDatagram, UnixListener, UnixStream},
				process::CommandExt as _,
			},
		},
		path::{Path, PathBuf},
		process::{Command, Stdio},
		sync::{
			Arc,
			atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering},
			mpsc,
		},
		thread,
		time::Duration,
	};

	use super::new_backend;
	use crate::desktop::types::DisplaySelector;

	/// Full libtest path of the child entry point. Renaming that test without
	/// updating this string leaves every probe child running zero tests, which
	/// [`probe`] reports instead of reading as a pass.
	const PROBE_TEST: &str = "desktop::linux::backend_selection_tests::selected_backend_probe";
	/// Prefix of the one line the child prints, so its decision survives
	/// libtest's own output.
	const PROBE_MARKER: &str = "omp-desktop-backend-probe:";
	/// Set on a spawned child to tell the ignored entry point to report.
	const PROBE_ENV: &str = "OMP_DESKTOP_BACKEND_PROBE";
	/// Descriptor number the parent hands the child for `WAYLAND_SOCKET`. Fixed
	/// so the child names it in `WAYLAND_SOCKET` whatever else is open.
	const CHILD_SOCKET_FD: RawFd = 100;
	/// `sun_path` carries 108 bytes including its terminator.
	const SOCKET_PATH_BUDGET: usize = 100;
	/// Bound on one probe child. A child that hangs is a backend bug, not a slow
	/// machine, and must not stall the suite.
	const PROBE_TIMEOUT: Duration = Duration::from_secs(60);
	/// Descriptor attempts one fixture may spend filling a one-slot backlog.
	const BACKLOG_FILL_ATTEMPTS: usize = 64;

	static NEXT_FIXTURE: AtomicU32 = AtomicU32::new(0);

	/// A private scratch directory for one case. Unique per process and case, so
	/// cases running in parallel never share a socket path.
	struct FixtureDir(PathBuf);

	impl FixtureDir {
		fn new(case: &str) -> Self {
			let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
			let name = format!("pi-desktop-sel-{}-{case}-{sequence}", std::process::id());
			// A per-test `TMPDIR` (Bazel sets a deep one) can be long enough that
			// a socket path under it overflows `sun_path`, so take whichever root
			// leaves room for the cases' own socket names.
			let root = [std::env::temp_dir(), PathBuf::from("/tmp")]
				.into_iter()
				.min_by_key(|root| root.join(&name).as_os_str().len())
				.expect("a fixture root");
			let path = root.join(name);
			let _ = fs::remove_dir_all(&path);
			fs::create_dir_all(&path).expect("create fixture directory");
			assert!(
				path.join("wayland-0").as_os_str().len() < SOCKET_PATH_BUDGET,
				"fixture root {} leaves no room for a socket path",
				root.display()
			);
			Self(path)
		}

		fn path(&self) -> &Path {
			&self.0
		}

		/// A socket file nobody listens on, the way a compositor's socket
		/// outlives the compositor after a logout.
		fn orphaned_socket(&self, name: &str) -> PathBuf {
			let path = self.0.join(name);
			drop(UnixListener::bind(&path).expect("bind orphaned socket"));
			assert!(
				fs::metadata(&path)
					.expect("orphaned socket file")
					.file_type()
					.is_socket(),
				"dropping the listener must leave a socket inode behind, else this fixture is not the \
				 stale endpoint it claims to be"
			);
			path
		}
	}

	impl Drop for FixtureDir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	/// A stand-in X server on loopback: it accepts and hangs up, so a client
	/// that reaches it fails fast instead of waiting for a setup reply that
	/// would never come. Cases only care whether anything connected.
	///
	/// The endpoint is `127.0.0.1:<display>`, not a socket path: x11rb 0.13
	/// resolves every `unix:` display to `/tmp/.X11-unix/X<n>` and discards the
	/// path `unix:<path>` carries, so a path fixture would be ignored — and on a
	/// desktop host it would point the probe at the developer's real X server.
	struct XServerFixture {
		connections: Arc<AtomicUsize>,
		stop:        Arc<AtomicBool>,
		acceptor:    Option<thread::JoinHandle<()>>,
	}

	impl XServerFixture {
		/// Starts the fixture and the `DISPLAY` that reaches it, or `None` when
		/// no loopback port was free. x11rb derives the port as 6000 + display,
		/// and seeding the display from the pid keeps two test processes apart.
		fn start() -> Option<(Self, OsString)> {
			let base = 100 + u16::try_from(std::process::id() % 400).ok()?;
			let (display, listener) = (base..base + 8).find_map(|display| {
				TcpListener::bind(("127.0.0.1", 6000 + display))
					.ok()
					.map(|listener| (display, listener))
			})?;
			// A blocked `accept` would outlive the fixture, so the acceptor polls
			// a stop flag instead. Clients still complete their connection into
			// the backlog, which is what the cases observe.
			listener.set_nonblocking(true).ok()?;
			let connections = Arc::new(AtomicUsize::new(0));
			let stop = Arc::new(AtomicBool::new(false));
			let acceptor = {
				let connections = Arc::clone(&connections);
				let stop = Arc::clone(&stop);
				thread::spawn(move || {
					while !stop.load(Ordering::Relaxed) {
						match listener.accept() {
							Ok((stream, _)) => {
								connections.fetch_add(1, Ordering::Relaxed);
								drop(stream);
							},
							Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
								thread::sleep(Duration::from_millis(5));
							},
							Err(_) => break,
						}
					}
				})
			};
			Some((
				Self { connections, stop, acceptor: Some(acceptor) },
				OsString::from(format!("127.0.0.1:{display}")),
			))
		}

		/// Connections seen once the acceptor has drained the backlog. The probe
		/// child has already exited by the time a case asks, so a connection it
		/// made is queued and one acceptor poll picks it up.
		fn settled_connections(&self) -> usize {
			thread::sleep(Duration::from_millis(100));
			self.connections.load(Ordering::Relaxed)
		}
	}

	impl Drop for XServerFixture {
		fn drop(&mut self) {
			self.stop.store(true, Ordering::Relaxed);
			if let Some(acceptor) = self.acceptor.take() {
				let _ = acceptor.join();
			}
		}
	}

	/// A listening socket whose backlog is one connection, built outside std
	/// because `UnixListener::bind` always asks for `SOMAXCONN`, which no test
	/// can fill within the usual descriptor limit. Filling it is the only way to
	/// observe what a client does when a compositor is alive but saturated.
	struct TinyBacklog {
		listener: RawFd,
		path:     PathBuf,
		clients:  Vec<RawFd>,
	}

	impl TinyBacklog {
		fn bind(path: &Path) -> Self {
			// SAFETY: a zeroed `sockaddr_un` is the value `bind` expects, and
			// `fill_address` documents that requirement.
			let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
			let len = unsafe { Self::fill_address(path, &mut address) }
				.unwrap_or_else(|| panic!("socket path {} does not fit in sun_path", path.display()));
			// SAFETY: `listener` is a fresh `AF_UNIX` socket, and `address`/`len`
			// describe a NUL-terminated path inside that struct.
			let listener = unsafe {
				let listener = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0);
				assert!(listener >= 0, "socket: {}", std::io::Error::last_os_error());
				let bound = libc::bind(listener, std::ptr::from_ref(&address).cast(), len);
				assert_eq!(bound, 0, "bind: {}", std::io::Error::last_os_error());
				assert_eq!(libc::listen(listener, 1), 0, "listen: {}", std::io::Error::last_os_error());
				listener
			};
			Self { listener, path: path.to_path_buf(), clients: Vec::new() }
		}

		/// Queues connections until the backlog is full, which is the state a
		/// later `connect` can only block on. Returns whether that state was
		/// reached.
		fn fill(&mut self) -> bool {
			for _ in 0..BACKLOG_FILL_ATTEMPTS {
				// SAFETY: as in `bind`; every descriptor opened here is closed by
				// `Drop`.
				unsafe {
					let mut address: libc::sockaddr_un = std::mem::zeroed();
					let Some(len) = Self::fill_address(&self.path, &mut address) else {
						return false;
					};
					let client = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_NONBLOCK, 0);
					if client < 0 {
						return false;
					}
					if libc::connect(client, std::ptr::from_ref(&address).cast(), len) == 0 {
						self.clients.push(client);
						continue;
					}
					let full = std::io::Error::last_os_error().raw_os_error() == Some(libc::EAGAIN);
					libc::close(client);
					return full;
				}
			}
			false
		}

		/// Describes `path` in `address` and returns the length `bind` or
		/// `connect` expects. The trailing NUL comes from `address` starting
		/// zeroed.
		///
		/// # Safety
		///
		/// `address` must be a zeroed `sockaddr_un`, exactly as
		/// `std::mem::zeroed()` produces.
		unsafe fn fill_address(
			path: &Path,
			address: &mut libc::sockaddr_un,
		) -> Option<libc::socklen_t> {
			let bytes = path.as_os_str().as_encoded_bytes();
			if bytes.len() + 1 > address.sun_path.len() {
				return None;
			}
			address.sun_family = libc::AF_UNIX as libc::sa_family_t;
			// SAFETY: `sun_path` has room for `bytes` plus the zeroed terminator.
			unsafe {
				std::ptr::copy_nonoverlapping(
					bytes.as_ptr(),
					address.sun_path.as_mut_ptr().cast::<u8>(),
					bytes.len(),
				);
			}
			libc::socklen_t::try_from(std::mem::size_of::<libc::sa_family_t>() + bytes.len() + 1).ok()
		}
	}

	impl Drop for TinyBacklog {
		fn drop(&mut self) {
			// SAFETY: every descriptor here was opened by this struct and is
			// closed exactly once.
			unsafe {
				for client in self.clients.drain(..) {
					libc::close(client);
				}
				libc::close(self.listener);
			}
		}
	}

	/// Whether this process is subject to directory permissions. Root bypasses
	/// them, so a permission-denied socket cannot be built there.
	fn permissions_apply(dir: &Path) -> bool {
		fs::read_dir(dir).is_err()
	}

	/// How `WAYLAND_SOCKET` reaches the child.
	#[derive(Default)]
	enum SocketEnv {
		/// Unset.
		#[default]
		Unset,
		/// This raw value, verbatim. libwayland parses the whole string as a
		/// descriptor number, so a malformed value has to be rejected rather
		/// than guessed at.
		Value(String),
		/// `CHILD_SOCKET_FD` carries a live compositor socket, the way socket
		/// activation hands one to a client.
		Live(UnixStream),
		/// `CHILD_SOCKET_FD` carries a stream socket with no connected peer.
		Unconnected(UnixListener),
		/// `CHILD_SOCKET_FD` carries a connected AF_UNIX datagram socket.
		Datagram(UnixDatagram),
		/// `CHILD_SOCKET_FD` carries a connected TCP socket.
		Tcp(TcpStream),
		/// `CHILD_SOCKET_FD` carries a stream whose peer is gone.
		ClosedPeer(UnixStream),
		/// `CHILD_SOCKET_FD` carries an open regular file: a number that parses
		/// but names no socket.
		NotASocket(File),
		/// `CHILD_SOCKET_FD` names no open descriptor.
		Closed,
	}

	impl SocketEnv {
		/// The descriptor this variant hands the child, or `None` for
		/// [`SocketEnv::Closed`], which has the child close the number itself.
		fn raw_fd(&self) -> Option<RawFd> {
			match self {
				SocketEnv::Live(value) => Some(value.as_raw_fd()),
				SocketEnv::Unconnected(value) => Some(value.as_raw_fd()),
				SocketEnv::Datagram(value) => Some(value.as_raw_fd()),
				SocketEnv::Tcp(value) => Some(value.as_raw_fd()),
				SocketEnv::ClosedPeer(value) => Some(value.as_raw_fd()),
				SocketEnv::NotASocket(value) => Some(value.as_raw_fd()),
				SocketEnv::Unset | SocketEnv::Value(_) | SocketEnv::Closed => None,
			}
		}
	}

	/// Opaque queued bytes whose preservation is observable by the consumer.
	const GREETING: &[u8] = b"wl_display";

	fn live_queued_socket() -> (UnixStream, UnixStream) {
		let (socket, mut peer) = UnixStream::pair().expect("socket pair");
		peer
			.write_all(GREETING)
			.expect("queue the compositor greeting");
		(socket, peer)
	}

	/// A connected TCP socket: the right socket type on the wrong family.
	fn connected_tcp() -> TcpStream {
		let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback");
		let address = listener.local_addr().expect("loopback address");
		let _client = TcpStream::connect(address).expect("connect loopback");
		let (server, _) = listener.accept().expect("accept loopback");
		server
	}

	/// The display environment one probe child runs under. Anything left unset
	/// stays unset in the child.
	#[derive(Default)]
	struct ProbeEnv {
		wayland_display: Option<OsString>,
		runtime_dir:     Option<PathBuf>,
		socket:          SocketEnv,
		display:         Option<OsString>,
	}

	impl ProbeEnv {
		/// A relative `WAYLAND_DISPLAY` resolved against a runtime directory,
		/// which is how a real compositor exports its socket.
		fn wayland(name: &str, runtime_dir: &Path) -> Self {
			Self {
				wayland_display: Some(OsString::from(name)),
				runtime_dir: Some(runtime_dir.to_path_buf()),
				..Self::default()
			}
		}

		/// An absolute `WAYLAND_DISPLAY` socket path.
		fn wayland_path(path: &Path) -> Self {
			Self { wayland_display: Some(path.as_os_str().to_owned()), ..Self::default() }
		}
	}

	/// What one probe child concluded about its environment.
	#[derive(Debug, PartialEq, Eq)]
	enum Decision {
		/// `new_backend` succeeded. The value is the published
		/// `DesktopCapabilities::backend` name that `computer status` reports.
		Backend(String),
		/// `new_backend` failed; the value is the published `ErrorCode` name,
		/// kept as text so a new code needs no change here.
		Failed(String),
	}

	/// One probe child's decision, plus the output that produced it so a failed
	/// assertion can show the child's own diagnostics.
	struct ProbeReport {
		case:     String,
		decision: Decision,
		log:      String,
	}

	impl ProbeReport {
		fn assert_backend(&self, expected: &str) {
			self.assert_decision(
				Decision::Backend(expected.to_string()),
				&format!("select the {expected} backend"),
			);
		}

		fn assert_failed(&self, code: &str) {
			self.assert_decision(Decision::Failed(code.to_string()), &format!("fail with {code}"));
		}

		fn assert_decision(&self, expected: Decision, expectation: &str) {
			assert_eq!(
				self.decision, expected,
				"case {} must {expectation}\nchild output:\n{}",
				self.case, self.log
			);
		}

		fn assert_not_backend(&self, unexpected: &str) {
			assert_ne!(
				self.decision,
				Decision::Backend(unexpected.to_string()),
				"case {} must not select the {unexpected} backend\nchild output:\n{}",
				self.case,
				self.log
			);
		}
	}

	/// Puts `source` on [`CHILD_SOCKET_FD`] in the child, or closes that number
	/// there when there is nothing to hand over, so `WAYLAND_SOCKET` names
	/// exactly what the case needs whatever descriptors this process holds open.
	fn hand_socket_fd_to_child(command: &mut Command, source: Option<RawFd>) {
		// SAFETY: the closure runs between fork and exec and calls only `dup2`,
		// `fcntl`, and `close`, all async-signal-safe. `source` belongs to a value
		// the caller keeps alive until `spawn` returns.
		unsafe {
			command.pre_exec(move || {
				let Some(source) = source else {
					// SAFETY: `CHILD_SOCKET_FD` is a number this process owns or has
					// already closed; either way the child must not inherit it.
					if libc::close(CHILD_SOCKET_FD) < 0 {
						// An unused number is the likely case here. Anything else means
						// the child could still hold a descriptor it must not.
						let error = std::io::Error::last_os_error();
						if error.raw_os_error() != Some(libc::EBADF) {
							return Err(error);
						}
					}
					return Ok(());
				};
				// SAFETY: `dup2` cannot unwind and touches only descriptors this
				// process owns.
				if libc::dup2(source, CHILD_SOCKET_FD) < 0 {
					return Err(std::io::Error::last_os_error());
				}
				// `dup2` copies nothing when both numbers match, and clears
				// FD_CLOEXEC only when it copies, so a source already sitting on
				// the child's number would reach exec still close-on-exec and
				// `WAYLAND_SOCKET` would name a descriptor that is not there.
				// SAFETY: both calls take only a descriptor number and an int, on a
				// descriptor this process owns, and are async-signal-safe.
				let flags = libc::fcntl(CHILD_SOCKET_FD, libc::F_GETFD);
				if flags < 0
					|| libc::fcntl(CHILD_SOCKET_FD, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
				{
					return Err(std::io::Error::last_os_error());
				}
				Ok(())
			});
		}
	}

	/// Builds the command for one probe child: this test binary re-run for the
	/// single ignored entry point, with a fixture-only environment. Everything
	/// the child would inherit from the developer's session is removed or
	/// redirected at a fixture path, so a case cannot depend on the machine it
	/// runs on.
	fn child_command(private: &Path, env: &ProbeEnv) -> Command {
		let mut command = Command::new(std::env::current_exe().expect("probe test binary"));
		command
			.args(["--ignored", "--exact", PROBE_TEST, "--nocapture"])
			.stdout(Stdio::piped());
		for name in ["WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XDG_RUNTIME_DIR", "DISPLAY", "NIRI_SOCKET"]
		{
			command.env_remove(name);
		}
		// A real compositor socket, accessibility bus, or state directory would
		// reach past the fixtures, so those point at the private directory too.
		let bus = format!("unix:path={}", private.join("bus").display());
		command
			.env(PROBE_ENV, "1")
			.env("XDG_STATE_HOME", private.join("state"))
			.env("HOME", private.join("home"))
			.env("DBUS_SESSION_BUS_ADDRESS", &bus)
			.env("AT_SPI_BUS_ADDRESS", &bus);

		if let Some(display) = &env.wayland_display {
			command.env("WAYLAND_DISPLAY", display);
		}
		if let Some(runtime_dir) = &env.runtime_dir {
			command.env("XDG_RUNTIME_DIR", runtime_dir);
		}
		if let Some(display) = &env.display {
			command.env("DISPLAY", display);
		}
		match &env.socket {
			SocketEnv::Unset => {},
			SocketEnv::Value(value) => {
				command.env("WAYLAND_SOCKET", value);
			},
			// `raw_fd() == None` closes the child's number there, which is what
			// makes the closed-descriptor case provably unoccupied.
			descriptor => {
				hand_socket_fd_to_child(&mut command, descriptor.raw_fd());
				command.env("WAYLAND_SOCKET", CHILD_SOCKET_FD.to_string());
			},
		}
		command
	}

	/// Runs one probe child under `env` and reports which backend that
	/// environment selects.
	fn probe(case: &str, env: ProbeEnv) -> ProbeReport {
		let private = FixtureDir::new(&format!("{case}-child"));
		let mut command = child_command(private.path(), &env);

		let mut child = command.spawn().expect("spawn probe child");
		let stdout = child.stdout.take().expect("probe child stdout");
		let (sender, receiver) = mpsc::channel();
		thread::spawn(move || {
			let mut log = String::new();
			let mut stdout = stdout;
			let _ = stdout.read_to_string(&mut log);
			let _ = sender.send(log);
		});
		let log = receiver.recv_timeout(PROBE_TIMEOUT).unwrap_or_else(|_| {
			let _ = child.kill();
			let _ = child.wait();
			panic!("case {case}: probe child reported nothing within {PROBE_TIMEOUT:?}");
		});
		let status = child.wait().expect("probe child exit");
		let decision = decision_of(&log).unwrap_or_else(|| {
			panic!(
				"case {case}: probe child ran no reporting test (status {status}); the --exact path \
				 {PROBE_TEST} may have drifted\nchild output:\n{log}"
			)
		});
		ProbeReport { case: case.to_string(), decision, log }
	}

	/// Reads the child's marker line, or `None` when it printed none.
	fn decision_of(log: &str) -> Option<Decision> {
		let line = log
			.lines()
			.find_map(|line| line.trim().strip_prefix(PROBE_MARKER))?;
		let (field, value) = line.split_once('=')?;
		match (field.trim(), value.trim()) {
			("backend", backend) => Some(Decision::Backend(backend.to_string())),
			("error", code) => Some(Decision::Failed(code.to_string())),
			_ => None,
		}
	}

	/// Child entry point. Spawned by [`probe`]; a normal suite pass skips it, so
	/// no run reaches `new_backend` without a controlled environment.
	#[test]
	#[ignore = "spawned by backend-selection tests"]
	fn selected_backend_probe() {
		if std::env::var_os(PROBE_ENV).is_none() {
			return;
		}
		let decision = match new_backend(DisplaySelector::All) {
			Ok(mut backend) => format!("backend={}", backend.capabilities().backend),
			Err(error) => format!("error={:?}", error.code),
		};
		println!("{PROBE_MARKER} {decision}");
	}

	/// A session with no display server keeps failing the way it always did, and
	/// an empty `WAYLAND_DISPLAY` is not a display server.
	#[test]
	fn absent_display_environment_fails_with_capture_failed() {
		probe("absent", ProbeEnv::default()).assert_failed("CaptureFailed");
		probe("empty-wayland-display", ProbeEnv {
			wayland_display: Some(OsString::new()),
			..ProbeEnv::default()
		})
		.assert_failed("CaptureFailed");
	}

	/// A `WAYLAND_DISPLAY` that names nothing a client can reach must not select
	/// Wayland. Each row is a way a stale name outlives its compositor: a
	/// relative name with no runtime directory, a name nobody listens on, an
	/// orphaned socket inode, and paths that are not sockets at all.
	#[test]
	fn unreachable_wayland_socket_name_is_not_selected() {
		let dir = FixtureDir::new("unreachable-name");
		let plain = dir.path().join("plain-file");
		fs::write(&plain, b"").expect("write regular file");
		let orphaned = dir.orphaned_socket("orphaned");

		let cases = [
			("no-runtime-dir", ProbeEnv {
				wayland_display: Some(OsString::from("wayland-0")),
				..ProbeEnv::default()
			}),
			("nothing-listening", ProbeEnv::wayland("wayland-0", dir.path())),
			("orphaned-socket-inode", ProbeEnv::wayland("orphaned", dir.path())),
			("regular-file", ProbeEnv::wayland("plain-file", dir.path())),
			("absolute-regular-file", ProbeEnv::wayland_path(&plain)),
			("absolute-orphaned-socket", ProbeEnv::wayland_path(&orphaned)),
		];
		for (case, env) in cases {
			probe(case, env).assert_failed("CaptureFailed");
		}
	}

	/// A `WAYLAND_SOCKET` that is not a live connected AF_UNIX stream must not
	/// select Wayland: a malformed value, a closed descriptor, a regular file, a
	/// stream with no peer, a datagram, a TCP socket, and a stream whose peer is
	/// gone are each rejected on their own ground.
	#[test]
	fn invalid_inherited_socket_fd_is_not_selected() {
		let dir = FixtureDir::new("socket-fd");
		let plain = File::create(dir.path().join("plain-file")).expect("create regular file");

		// One value per way libwayland's whole-string descriptor parse can be
		// handed something that is not a descriptor number.
		for value in ["", " ", "x", "3x", "-1", "99999999999999999999"] {
			let env = ProbeEnv { socket: SocketEnv::Value(value.to_string()), ..ProbeEnv::default() };
			probe("malformed-socket-fd", env).assert_failed("CaptureFailed");
		}
		let (stream, gone) = UnixStream::pair().expect("socket pair");
		drop(stream);
		let (buffered, mut sender) = UnixStream::pair().expect("buffered socket pair");
		sender
			.write_all(GREETING)
			.expect("queue bytes before closing the peer");
		drop(sender);
		let (datagram, _peer) = UnixDatagram::pair().expect("datagram pair");
		let unconnected = UnixListener::bind(dir.path().join("listener")).expect("bind listener");
		for (case, socket) in [
			("closed-socket-fd", SocketEnv::Closed),
			("non-socket-fd", SocketEnv::NotASocket(plain)),
			("unconnected-stream", SocketEnv::Unconnected(unconnected)),
			("connected-datagram", SocketEnv::Datagram(datagram)),
			("connected-tcp", SocketEnv::Tcp(connected_tcp())),
			("closed-peer", SocketEnv::ClosedPeer(gone)),
			("closed-peer-with-buffered-data", SocketEnv::ClosedPeer(buffered)),
		] {
			probe(case, ProbeEnv { socket, ..ProbeEnv::default() }).assert_failed("CaptureFailed");
		}
	}

	/// Selecting an inherited socket must leave its queued bytes for the client.
	#[test]
	fn inherited_compositor_socket_is_live_and_keeps_its_protocol_bytes() {
		let (mut socket, _peer) = live_queued_socket();
		let for_child = socket.try_clone().expect("clone for the child");
		let report = probe("live-queued-protocol-bytes", ProbeEnv {
			socket: SocketEnv::Live(for_child),
			..ProbeEnv::default()
		});
		report.assert_backend("wayland");

		let mut buffer = [0_u8; 16];
		let read = socket.read(&mut buffer).expect("read what the peer queued");
		assert_eq!(&buffer[..read], GREETING, "selection must not consume protocol bytes");
	}

	/// Every way a compositor really exports its socket selects Wayland: a
	/// relative name under a runtime directory, an absolute socket path, and an
	/// inherited descriptor even when the name beside it is stale.
	#[test]
	fn reachable_wayland_socket_is_selected() {
		let relative = FixtureDir::new("live-relative");
		let _listener =
			UnixListener::bind(relative.path().join("wayland-0")).expect("bind compositor socket");
		probe("live-relative-name", ProbeEnv::wayland("wayland-0", relative.path()))
			.assert_backend("wayland");

		let absolute = FixtureDir::new("live-absolute");
		let socket = absolute.path().join("compositor.sock");
		let _listener = UnixListener::bind(&socket).expect("bind compositor socket");
		probe("live-absolute-path", ProbeEnv::wayland_path(&socket)).assert_backend("wayland");

		let (socket, _peer) = UnixStream::pair().expect("idle live socket pair");
		let env = ProbeEnv { socket: SocketEnv::Live(socket), ..ProbeEnv::default() };
		probe("live-inherited-fd", env).assert_backend("wayland");

		let stale = FixtureDir::new("live-fd-stale-name");
		let (socket, _stale_name_peer) = UnixStream::pair().expect("live socket beside stale name");
		let env = ProbeEnv {
			socket: SocketEnv::Live(socket),
			..ProbeEnv::wayland("wayland-0", stale.path())
		};
		probe("live-inherited-fd-stale-name", env).assert_backend("wayland");
	}

	/// A reachable Wayland session wins over a configured X11 display, and the
	/// X11 server is never even contacted. Selection happens before anything is
	/// captured, so a later capture-permission or PipeWire failure must not move
	/// the session to X11.
	#[test]
	fn reachable_wayland_socket_never_falls_back_to_x11() {
		let dir = FixtureDir::new("wayland-over-x11");
		let _listener =
			UnixListener::bind(dir.path().join("wayland-0")).expect("bind compositor socket");
		let Some((x11, display)) = XServerFixture::start() else {
			eprintln!("no loopback port free for the X fixture; skipping");
			return;
		};

		let env =
			ProbeEnv { display: Some(display.clone()), ..ProbeEnv::wayland("wayland-0", dir.path()) };
		probe("live-wayland-over-x11", env).assert_backend("wayland");
		assert_eq!(x11.settled_connections(), 0, "a reachable Wayland session must not contact X11");

		let (socket, _peer) = UnixStream::pair().expect("live socket beside X11");
		let env = ProbeEnv {
			socket: SocketEnv::Live(socket),
			display: Some(display),
			..ProbeEnv::default()
		};
		probe("live-inherited-fd-over-x11", env).assert_backend("wayland");
		assert_eq!(x11.settled_connections(), 0, "a reachable Wayland session must not contact X11");
	}

	/// Selection only proves a socket accepts a connection. Speaking compositor
	/// protocol to it here would consume one of a real compositor's connection
	/// slots on every `computer` start.
	#[test]
	fn selecting_wayland_never_starts_a_compositor_handshake() {
		let dir = FixtureDir::new("no-handshake");
		let listener =
			UnixListener::bind(dir.path().join("wayland-0")).expect("bind compositor socket");
		probe("no-handshake", ProbeEnv::wayland("wayland-0", dir.path())).assert_backend("wayland");

		let (mut stream, _) = listener
			.accept()
			.expect("selection must prove the socket is reachable");
		stream
			.set_read_timeout(Some(PROBE_TIMEOUT))
			.expect("socket read deadline");
		let mut buffer = [0_u8; 64];
		match stream.read(&mut buffer) {
			// The child closed its end without sending anything.
			Ok(0) => {},
			Ok(sent) => panic!(
				"backend selection sent {sent} bytes of compositor protocol to a reachable socket; \
				 selection must not consume a compositor connection"
			),
			Err(error) => panic!("reading the selected compositor socket failed: {error}"),
		}
	}

	/// A Wayland socket this process may not open is blocked, not stale. The
	/// session stays on Wayland, and X11 is never contacted, because a
	/// permission failure says nothing about whether the compositor is alive.
	#[test]
	fn permission_denied_wayland_socket_does_not_switch_to_x11() {
		let dir = FixtureDir::new("permission-denied");
		let locked = dir.path().join("locked");
		fs::create_dir_all(&locked).expect("create locked directory");
		let _listener = UnixListener::bind(locked.join("wayland-0")).expect("bind compositor socket");
		// Unsearchable parent: the socket exists and answers, but this process may
		// not reach it. Root ignores directory permissions, so the case needs a
		// process they bind on; ask a throwaway directory first.
		let probe_dir = dir.path().join("permission-probe");
		fs::create_dir_all(&probe_dir).expect("create permission probe directory");
		fs::set_permissions(&probe_dir, fs::Permissions::from_mode(0o000)).expect("lock probe");
		let applies = permissions_apply(&probe_dir);
		fs::set_permissions(&probe_dir, fs::Permissions::from_mode(0o700)).expect("unlock probe");
		if !applies {
			eprintln!("directory permissions do not bind for this user; skipping");
			return;
		}
		fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).expect("lock directory");
		let Some((x11, display)) = XServerFixture::start() else {
			eprintln!("no loopback port free for the X fixture; skipping");
			return;
		};

		let env = ProbeEnv { display: Some(display), ..ProbeEnv::wayland("wayland-0", &locked) };
		let report = probe("permission-denied-wayland", env);
		fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).expect("unlock directory");

		report.assert_not_backend("x11");
		assert_eq!(
			x11.settled_connections(),
			0,
			"a blocked Wayland socket must not fall back to X11"
		);
	}

	/// A compositor whose backlog is full is alive but saturated. Probing it
	/// must not hang the session, and must not read the blockage as staleness.
	#[test]
	fn saturated_wayland_socket_does_not_hang_or_switch_to_x11() {
		let dir = FixtureDir::new("saturated");
		let Some((x11, display)) = XServerFixture::start() else {
			eprintln!("no loopback port free for the X fixture; skipping");
			return;
		};
		let mut listener = TinyBacklog::bind(&dir.path().join("wayland-0"));
		if !listener.fill() {
			eprintln!("could not fill a one-slot backlog; skipping");
			return;
		}
		let env = ProbeEnv { display: Some(display), ..ProbeEnv::wayland("wayland-0", dir.path()) };
		probe("saturated-wayland", env).assert_backend("wayland");
		assert_eq!(
			x11.settled_connections(),
			0,
			"a saturated Wayland session must not fall back to X11"
		);
	}

	/// A Wayland environment that reaches nothing does not hide a configured X11
	/// display: selection falls through and reaches X11, which then fails here
	/// because the fixture server hangs up instead of answering.
	#[test]
	fn stale_wayland_environment_falls_through_to_x11() {
		let dir = FixtureDir::new("stale-wayland-over-x11");
		let Some((x11, display)) = XServerFixture::start() else {
			eprintln!("no loopback port free for the X fixture; skipping");
			return;
		};
		let env = ProbeEnv {
			socket: SocketEnv::Closed,
			display: Some(display),
			..ProbeEnv::wayland("wayland-0", dir.path())
		};

		let report = probe("stale-wayland-with-x11", env);
		report.assert_failed("CaptureFailed");
		assert!(
			x11.settled_connections() >= 1,
			"a Wayland environment that reaches nothing must fall through to the configured X11 \
			 display"
		);
	}

	/// Positive proof of the X11 fallback: with a live X server and a stale
	/// Wayland name, the session gets the X11 backend.
	///
	/// Needs a reachable X server. A headless host has none, so the test says
	/// how to get one and returns; run the suite under `xvfb-run -a` to
	/// exercise it.
	#[test]
	fn stale_wayland_environment_falls_back_to_a_live_x11_display() {
		let Some(display) = std::env::var_os("DISPLAY").filter(|display| !display.is_empty()) else {
			eprintln!("no ambient DISPLAY; run under `xvfb-run -a` to reach the X11 fallback");
			return;
		};
		let dir = FixtureDir::new("live-x11");
		let report = probe("live-x11-fallback", ProbeEnv {
			display: Some(display),
			..ProbeEnv::wayland("wayland-0", dir.path())
		});
		if matches!(&report.decision, Decision::Failed(code) if code == "CaptureFailed") {
			eprintln!("ambient DISPLAY serves no X server; run under `xvfb-run -a`");
			return;
		}
		report.assert_backend("x11");
	}
}
