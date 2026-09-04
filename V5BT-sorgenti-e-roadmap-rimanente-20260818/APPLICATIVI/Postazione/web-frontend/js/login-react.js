(function (global) {
	"use strict";

	const React = global.React;
	const ReactDOM = global.ReactDOM;

	const API_BASE =
		typeof global.API_BASE === "string" && global.API_BASE.trim().length > 0
			? global.API_BASE.trim()
			: String(global.location && global.location.origin || "");
	const DEVICE_UUID_KEY = "postazione_device_uuid";
	const LAST_USERNAME_KEY = "postazione_last_username";
	const REMEMBER_USERNAME_KEY = "postazione_remember_username";

	const QUICK_USERS = [
		{ username: "gianluca", label: "Operatore" },
		{ username: "lorenzo", label: "Admin" },
		{ username: "admin", label: "Admin 2" }
	];

	function safeStorageGet(key) {
		try {
			return global.localStorage.getItem(key);
		} catch (_) {
			return null;
		}
	}

	function safeStorageSet(key, value) {
		try {
			global.localStorage.setItem(key, value);
		} catch (_) {}
	}

	function safeStorageRemove(key) {
		try {
			global.localStorage.removeItem(key);
		} catch (_) {}
	}

	function fallbackUuid() {
		const bytes = new Uint8Array(16);
		for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;
		const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	}

	function getOrCreateDeviceUuid() {
		const fromStore = String(safeStorageGet(DEVICE_UUID_KEY) || "").trim();
		if (fromStore) return fromStore;
		let value = "";
		try {
			if (global.crypto && typeof global.crypto.randomUUID === "function") {
				value = global.crypto.randomUUID();
			}
		} catch (_) {}
		if (!value) value = fallbackUuid();
		safeStorageSet(DEVICE_UUID_KEY, value);
		return value;
	}

	function getBackendStatusLabel(status) {
		if (status === "online") return "Backend online";
		if (status === "offline") return "Backend offline";
		return "Verifica backend";
	}

	function normalizeRole(user) {
		if (!user || typeof user !== "object") return "Operatore";
		const roleLabel = String(user.roleLabel || "").trim();
		const role = String(user.role || "").trim();
		return roleLabel || role || "Operatore";
	}

	function normalizeName(user, fallbackUsername) {
		if (!user || typeof user !== "object") return fallbackUsername;
		const fullName = String(user.fullName || "").trim();
		const username = String(user.username || "").trim();
		return fullName || username || fallbackUsername;
	}

	async function checkBackendStatus(setStatus) {
		const ctrl = new AbortController();
		const timeout = global.setTimeout(() => ctrl.abort(), 2200);
		setStatus("checking");
		try {
			const response = await fetch(`${API_BASE}/api/health`, {
				method: "GET",
				headers: { Accept: "application/json" },
				signal: ctrl.signal
			});
			setStatus(response.ok ? "online" : "offline");
		} catch (_) {
			setStatus("offline");
		} finally {
			global.clearTimeout(timeout);
		}
	}

	function emit(name, detail) {
		global.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
	}

	function LoginModal() {
		const h = React.createElement;
		const savedRemember = safeStorageGet(REMEMBER_USERNAME_KEY) !== "0";
		const savedUsername = String(safeStorageGet(LAST_USERNAME_KEY) || "gianluca").trim() || "gianluca";

		const [visible, setVisible] = React.useState(false);
		const [loggedIn, setLoggedIn] = React.useState(false);
		const [currentName, setCurrentName] = React.useState("Guest");
		const [currentRole, setCurrentRole] = React.useState("Non autenticato");
		const [username, setUsername] = React.useState(savedUsername);
		const [pin, setPin] = React.useState("");
		const [showPin, setShowPin] = React.useState(false);
		const [rememberUsername, setRememberUsername] = React.useState(savedRemember);
		const [backendStatus, setBackendStatus] = React.useState("checking");
		const [isPending, setIsPending] = React.useState(false);
		const [error, setError] = React.useState("");

		const usernameRef = React.useRef(null);
		const pinRef = React.useRef(null);
		const submitRef = React.useRef(null);
		const rememberRef = React.useRef(rememberUsername);
		const usernameValueRef = React.useRef(username);

		React.useEffect(() => {
			rememberRef.current = rememberUsername;
		}, [rememberUsername]);

		React.useEffect(() => {
			usernameValueRef.current = username;
		}, [username]);

		React.useEffect(() => {
			function onOpen(event) {
				const detail = event && event.detail && typeof event.detail === "object" ? event.detail : {};
				setVisible(true);
				setLoggedIn(Boolean(detail.loggedIn));
				setCurrentName(String(detail.userName || "Guest"));
				setCurrentRole(String(detail.userRole || "Non autenticato"));
				if (detail.userName && !rememberRef.current) {
					setUsername(String(detail.userName));
				}
				setPin("");
				setShowPin(false);
				setError("");
				void checkBackendStatus(setBackendStatus);
				global.setTimeout(() => {
					if (detail.loggedIn) return;
					if (String(usernameValueRef.current || "").trim().length > 0) {
						if (pinRef.current) pinRef.current.focus();
						return;
					}
					if (usernameRef.current) usernameRef.current.focus();
				}, 0);
			}

			function onClose() {
				setVisible(false);
				setPin("");
				setShowPin(false);
				setError("");
				setIsPending(false);
			}

			function onSubmitRequest() {
				if (submitRef.current) submitRef.current.click();
			}

			global.addEventListener("postazione-login-open", onOpen);
			global.addEventListener("postazione-login-close", onClose);
			global.addEventListener("postazione-login-submit", onSubmitRequest);
			return () => {
				global.removeEventListener("postazione-login-open", onOpen);
				global.removeEventListener("postazione-login-close", onClose);
				global.removeEventListener("postazione-login-submit", onSubmitRequest);
			};
		}, []);

		if (!visible) return null;

		const deviceUuid = getOrCreateDeviceUuid();
		const shortDevice = deviceUuid.length > 12 ? `${deviceUuid.slice(0, 12)}...` : deviceUuid;
		const canSubmit = username.trim().length > 0 && /^\d{4,6}$/.test(pin) && !isPending;

		async function handleSubmit(event) {
			event.preventDefault();
			const safeUsername = username.trim();
			if (!safeUsername) {
				setError("Inserisci username.");
				return;
			}
			if (!/^\d{4,6}$/.test(pin)) {
				setError("PIN non valido (4-6 cifre).");
				return;
			}

			setError("");
			setIsPending(true);
			try {
				const response = await fetch(`${API_BASE}/api/auth/login`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						username: safeUsername,
						pin,
						deviceUuid,
						clientApp: "postazione"
					})
				});

				let payload = null;
				try {
					payload = await response.json();
				} catch (_) {}

				if (!response.ok || !payload || payload.ok !== true) {
					const message =
						payload && typeof payload.error === "string" && payload.error.trim().length > 0
							? payload.error.trim()
							: `Errore login (${response.status})`;
					throw new Error(message);
				}

				const user = payload && payload.user && typeof payload.user === "object" ? payload.user : {};
				const fullName = normalizeName(user, safeUsername);
				const roleLabel = normalizeRole(user);

				if (rememberUsername) {
					safeStorageSet(LAST_USERNAME_KEY, safeUsername);
					safeStorageSet(REMEMBER_USERNAME_KEY, "1");
				} else {
					safeStorageRemove(LAST_USERNAME_KEY);
					safeStorageSet(REMEMBER_USERNAME_KEY, "0");
				}

				setLoggedIn(true);
				setCurrentName(fullName);
				setCurrentRole(roleLabel);
				setPin("");
				emit("postazione-login-success", {
					token: String(payload.token || ""),
					username: safeUsername,
					fullName,
					role: roleLabel,
					roleLabel,
					user
				});
			} catch (err) {
				const message =
					err && typeof err.message === "string" && err.message.trim().length > 0
						? err.message.trim()
						: "Errore di rete.";
				setError(message);
				setBackendStatus("offline");
			} finally {
				setIsPending(false);
			}
		}

		function handleClose() {
			if (typeof global.closeUserModal === "function") {
				global.closeUserModal();
				return;
			}
			emit("postazione-login-close", {});
		}

		function handleLogout() {
			emit("postazione-login-logout", {});
		}

		function renderLoggedIn() {
			return h(
				"div",
				{ className: "login-react-session" },
				h("div", { className: "login-react-session-title" }, "Sessione attiva"),
				h("div", { className: "login-react-session-name" }, currentName),
				h("div", { className: "login-react-session-role" }, currentRole),
				h(
					"div",
					{ className: "login-react-actions" },
					h(
						"button",
						{ type: "button", className: "modal-btn", onClick: handleClose },
						"Chiudi"
					),
					h(
						"button",
						{ type: "button", className: "modal-btn danger", onClick: handleLogout },
						"Logout"
					)
				)
			);
		}

		function renderLoginForm() {
			return h(
				"form",
				{ className: "login-react-form", onSubmit: handleSubmit },
				h(
					"div",
					{ className: "login-react-presets", "aria-label": "Utenti rapidi" },
					QUICK_USERS.map((quick) =>
						h(
							"button",
							{
								key: quick.username,
								type: "button",
								className:
									"login-react-preset" +
									(username.trim().toLowerCase() === quick.username ? " is-active" : ""),
								onClick: () => {
									setUsername(quick.username);
									setError("");
									global.setTimeout(() => {
										if (pinRef.current) pinRef.current.focus();
									}, 0);
								}
							},
							h("strong", null, quick.username),
							h("span", null, quick.label)
						)
					)
				),
				h(
					"label",
					{ className: "modal-row login-react-field" },
					h("span", { className: "modal-label" }, "Username"),
					h("input", {
						ref: usernameRef,
						className: "modal-input",
						autoComplete: "username",
						inputMode: "text",
						value: username,
						onChange: (event) => setUsername(event.target.value),
						placeholder: "Es: gianluca"
					})
				),
				h(
					"label",
					{ className: "modal-row login-react-field" },
					h("span", { className: "modal-label" }, "PIN"),
					h(
						"div",
						{ className: "login-react-pin-wrap" },
						h("input", {
							ref: pinRef,
							className: "modal-input",
							type: showPin ? "text" : "password",
							autoComplete: "current-password",
							inputMode: "numeric",
							maxLength: 6,
							pattern: "[0-9]*",
							value: pin,
							onChange: (event) => setPin(String(event.target.value || "").replace(/\D/g, "")),
							placeholder: "4-6 cifre"
						}),
						h(
							"button",
							{
								type: "button",
								className: "login-react-pin-toggle",
								onClick: () => setShowPin((prev) => !prev),
								"aria-label": showPin ? "Nascondi PIN" : "Mostra PIN"
							},
							showPin ? "Nascondi" : "Mostra"
						)
					)
				),
				h(
					"label",
					{ className: "login-react-remember" },
					h("input", {
						type: "checkbox",
						checked: rememberUsername,
						onChange: (event) => setRememberUsername(Boolean(event.target.checked))
					}),
					h("span", null, "Ricorda username")
				),
				error
					? h("div", { className: "login-react-error", role: "alert" }, error)
					: null,
				h(
					"div",
					{ className: "login-react-actions" },
					h(
						"button",
						{ type: "button", className: "modal-btn", onClick: handleClose },
						"Annulla"
					),
					h(
						"button",
						{
							ref: submitRef,
							type: "submit",
							className: "modal-btn primary",
							disabled: !canSubmit
						},
						isPending ? "Accesso..." : "Accedi"
					)
				)
			);
		}

		return h(
			"div",
			{ className: "modal-card login-react-card" },
			h(
				"div",
				{ className: "modal-head" },
				h(
					"div",
					{ className: "modal-title" },
					h("i", { className: "fa-solid fa-user-lock" }),
					" Accesso postazione"
				),
				h(
					"button",
					{
						type: "button",
						className: "modal-close",
						onClick: handleClose,
						"aria-label": "Chiudi"
					},
					h("i", { className: "fa-solid fa-xmark" })
				)
			),
			h(
				"div",
				{ className: "modal-body login-react-body" },
				h(
					"div",
					{ className: "login-react-meta" },
					h(
						"span",
						{ className: `login-react-pill is-${backendStatus}` },
						getBackendStatusLabel(backendStatus)
					),
					h("span", { className: "login-react-device" }, `Device: ${shortDevice}`)
				),
				loggedIn ? renderLoggedIn() : renderLoginForm()
			)
		);
	}

	let root = null;

	function renderFallback(mount) {
		if (!mount) return;
		mount.innerHTML =
			'<div class="modal-card"><div class="modal-body"><div class="modal-hint">React non disponibile: impossibile inizializzare la login.</div></div></div>';
	}

	function ensureMounted() {
		const mount = global.document.getElementById("loginReactRoot");
		if (!mount) return false;
		if (!React || !ReactDOM || typeof ReactDOM.createRoot !== "function") {
			renderFallback(mount);
			return false;
		}
		if (root) return true;
		root = ReactDOM.createRoot(mount);
		root.render(React.createElement(LoginModal));
		return true;
	}

	global.postazioneLoginUI = {
		ensureMounted,
		open(payload) {
			const mounted = ensureMounted();
			if (!mounted) return;
			global.setTimeout(() => emit("postazione-login-open", payload || {}), 0);
		},
		close() {
			emit("postazione-login-close", {});
		},
		requestSubmit() {
			emit("postazione-login-submit", {});
		}
	};
})(window);
