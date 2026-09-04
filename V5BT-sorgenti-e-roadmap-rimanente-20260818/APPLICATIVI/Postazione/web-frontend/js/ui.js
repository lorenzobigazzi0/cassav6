function $(id) { return document.getElementById(id); }
function pad2(n) { return String(n).padStart(2, "0"); }
function fmtMMSS(ms) {
	const t = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(t / 60);
	const s = t % 60;
	return `${pad2(m)}:${pad2(s)}`;
}
function toast(msg, durationMs = 1600) {
	const el = $("toast");
	el.textContent = msg;
	el.classList.add("show");
	clearTimeout(toast._t);
	const timeoutMs = Number.isFinite(Number(durationMs))
		? Math.max(400, Math.trunc(Number(durationMs)))
		: 1600;
	toast._t = setTimeout(() => el.classList.remove("show"), timeoutMs);
}

function updateStationsSelf() {
	const me = stationsState.find(s => s.name === state.stationName);
	if (!me) return;
	me.active = state.stationActive;
	me.operatorName = state.loggedIn ? state.userName : "Guest";
	me.operatorRole = state.loggedIn ? state.userRole : "Non autenticato";
}

function getStationStateByName(name) {
	return stationsState.find(s => s.name === name) || null;
}


function isOrderItemDisabled(orderItem, station) {
	if (!orderItem) return true;
	if (orderItem.ignoreDisabled) return false;
	return isItemDisabledForStation(orderItem.name, station);
}

function protectExistingOrderLinesFromDisable(itemName, stationOrNull) {
	const k = keyName(itemName);
	orders.forEach(o => {
		// Se stationOrNull e valorizzata, proteggio solo le comande di quella postazione.
		if (stationOrNull && o.station !== stationOrNull) return;
		o.items.forEach(it => {
			if (it && keyName(it.name) === k) it.ignoreDisabled = true;
		});
	});
}
function isStationOnline(name) {
	const st = getStationStateByName(name);
	if (!st) return true;
	return !!st.active;
}

function normalizeOrderWorkflowStatus(value) {
	const raw = String(value || "").trim().toLowerCase();
	if (raw === "done" || raw === "delivered" || raw === "consegnato") return "delivered";
	if (raw === "ready" || raw === "da consegnare" || raw === "da_consegnare") return "ready";
	if (raw === "prep" || raw === "in preparazione" || raw === "in_preparazione") return "prep";
	return "waiting";
}

function hasPositiveTimestamp(value) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0;
}

function computeStatus(order) {
	// Le righe non disponibili per la postazione non devono bloccare il passaggio a "DA RITIRARE".
	const station = order.station || state.stationName;
	const effective = order.items.filter(i => !isOrderItemDisabled(i, station));
	const total = effective.length;
	const doneCount = effective.filter(i => i.done).length;
	const workflow = normalizeOrderWorkflowStatus(order.workflowStatus);
	const completed = hasPositiveTimestamp(order.completedAtMs);
	if (completed || workflow === "delivered") return "done";
	if (workflow === "ready") return "ready";

	// prep = in preparazione (esplicito) oppure ha gia' spunte (tra le righe selezionabili)
	if (workflow === "prep") return "prep";
	if (total > 0 && doneCount === total) return "ready";
	if (doneCount > 0) return "prep";
	return "new";
}

function statusLabel(st) {
	if (st === "new") return "INVIATO";
	if (st === "prep") return "IN PREPARAZIONE";
	if (st === "ready") return "DA RITIRARE";
	return "CONSEGNATO";
}

function isArchivedForPostazioneStatus(st) {
	return st === "ready";
}

function isAlwaysHiddenForPostazioneStatus(st) {
	return st === "done";
}

function getOrderById(id) { return orders.find(o => o.id === id) || null; }

function isOrderVisibleForCurrentStation(order) {
	if (!order || typeof order !== "object") return false;
	if (typeof isOrderForCurrentStation === "function") {
		const delegated = isOrderForCurrentStation(order);
		if (delegated) return true;
	}
		if (order.broadcastToAllStations === true) return true;
		return String(order.station || "") === String(state?.stationName || "");
	}

function getVisibleOrdersForStation() {
	const q = state.searchQuery.trim().toLowerCase();
	return orders.filter(o => {
		// Modalita' operativa corrente: mostra sempre tutte le comande sincronizzate.
		const st = computeStatus(o);
		if (isAlwaysHiddenForPostazioneStatus(st)) return false;
		if (!state.showDone && isArchivedForPostazioneStatus(st)) return false;
		if (!q) return true;
		const s1 = buildOrderTableLabel(o).toLowerCase();
		const s2 = String(o.waiter).toLowerCase();
		const s3 = String(o.id).toLowerCase();
		const s4 = buildOrderRoomLabel(o).toLowerCase();
		return s1.includes(q) || s2.includes(q) || s3.includes(q) || s4.includes(q) || (`#${s3}`).includes(q);
	});
}

function sortOrders(list) {
	// Ordine: dalla piu' vecchia (in attesa da piu' tempo) alla piu' recente
	return [...list].sort((a, b) => a.receivedAtMs - b.receivedAtMs);
}

function getOrderElapsedMs(order) {
	const end = hasPositiveTimestamp(order.completedAtMs) ? Number(order.completedAtMs) : Date.now();
	return end - order.receivedAtMs;
}

function getCurrentPrepOrder() {
	const list = orders.filter(o => isOrderVisibleForCurrentStation(o));
	return list.find(o => normalizeOrderWorkflowStatus(o.workflowStatus) === "prep" && !isArchivedForPostazioneStatus(computeStatus(o))) || null;
}

function ensureAutoPrep() {
	const prep = getCurrentPrepOrder();
	if (prep) return;
	const candidates = orders
		.filter(o => isOrderVisibleForCurrentStation(o))
		.filter(o => !isArchivedForPostazioneStatus(computeStatus(o)))
		.filter(o => normalizeOrderWorkflowStatus(o.workflowStatus) === "waiting");
	if (!candidates.length) return;

	// "ultima disponibile" -> interpreto come ultima arrivata tra quelle in attesa
	const pick = [...candidates].sort((a, b) => b.receivedAtMs - a.receivedAtMs)[0];
	pick.workflowStatus = "prep";
	setOwner(pick, state.stationName);
}

function ensureSelection() {
	const visible = sortOrders(getVisibleOrdersForStation());
	// Non cambiare la comanda "in carico" solo perche non e visibile nel filtro ricerca.
	// Cambia selezione solo se la comanda selezionata non esiste piu per la postazione / toggle terminate.
	const base = sortOrders(
		orders
			.filter(o => isOrderVisibleForCurrentStation(o))
			.filter(o => !isAlwaysHiddenForPostazioneStatus(computeStatus(o)))
			.filter(o => state.showDone || !isArchivedForPostazioneStatus(computeStatus(o)))
	);
	if (state.selectedOrderId && base.find(o => o.id === state.selectedOrderId)) return;
	state.selectedOrderId = visible.length ? visible[0].id : null;

	// Se la selezione cambia (es. filtro ricerca o toggle terminate),
	// e non c'e' una comanda in corso "bloccata" da articoli gia' spuntati,
	// porto automaticamente la selezione in "IN PREPARAZIONE".
	if (state.stationActive && state.selectedOrderId) {
		const o = getOrderById(state.selectedOrderId);
		if (o) maybeSwitchPrepTo(o);
	}
}

function renderTop() {
	$("stationValue").textContent = state.stationName;

	$("userNameText").textContent = state.loggedIn ? state.userName : "Guest";
	$("userRoleText").textContent = state.loggedIn ? state.userRole : "Non autenticato";

	const initials = state.loggedIn
		? (state.userName.trim().split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() || "").join(""))
		: "G";
	$("avatarCircle").textContent = initials || "G";

	$("systemText").textContent = state.stationActive ? "ONLINE" : "PAUSA";
	$("systemDot").style.animationPlayState = state.stationActive ? "running" : "paused";

	const st = $("stationToggle");
	if (st.checked !== state.stationActive) st.checked = state.stationActive;

	const dt = $("darkToggle");
	if (dt.checked !== state.darkMode) dt.checked = state.darkMode;

	const ht = $("historyToggle");
	if (ht && ht.checked !== state.showDone) ht.checked = state.showDone;

	document.body.setAttribute("data-theme", state.darkMode ? "dark" : "light");

	// controlli sidebar
	const btnDone = $("btnToggleDone");
	if (btnDone) {
		btnDone.textContent = state.showDone ? "NASCONDI DA RITIRARE" : "MOSTRA DA RITIRARE";
		btnDone.classList.toggle("active", state.showDone);
	}
}

function renderClock() {
	const now = new Date();
	const months = ["GENNAIO", "FEBBRAIO", "MARZO", "APRILE", "MAGGIO", "GIUGNO", "LUGLIO", "AGOSTO", "SETTEMBRE", "OTTOBRE", "NOVEMBRE", "DICEMBRE"];
	$("dateText").textContent = `${pad2(now.getDate())} ${months[now.getMonth()]} ${now.getFullYear()}`;
	$("timeText").textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

function applyPauseUI() {
	const paused = !state.stationActive;
	const overlay = $("pauseOverlay");
	overlay.style.display = paused ? "flex" : "none";
	overlay.setAttribute("aria-hidden", paused ? "false" : "true");

	// Kiosk lock: disabilita tutto tranne lo switch Play/Pausa
	document.body.classList.toggle("is-paused", paused);
}

function updateSelectedCard() {
	document.querySelectorAll(".order-card").forEach(c => {
		c.classList.toggle("selected", c.dataset.orderId === state.selectedOrderId);
	});
}

function updateOrdersTimersAndStatus() {
	const listEl = $("ordersList");
	if (!listEl) return;
	listEl.querySelectorAll(".order-card").forEach(card => {
		const id = card.dataset.orderId;
		const o = getOrderById(id);
		if (!o) return;

		const st = computeStatus(o);
		const strip = card.querySelector(".status-strip");
		const badge = card.querySelector(".status-badge");
		const timerEl = card.querySelector(".timer");

		timerEl.textContent = fmtMMSS(getOrderElapsedMs(o));

		strip.classList.toggle("st-new", st === "new");
		strip.classList.toggle("st-prep", st === "prep");
		strip.classList.toggle("st-ready", st === "ready");
		strip.classList.toggle("st-done", st === "done");

		badge.classList.toggle("bg-new", st === "new");
		badge.classList.toggle("bg-prep", st === "prep");
		badge.classList.toggle("bg-ready", st === "ready");
		badge.classList.toggle("bg-done", st === "done");
		badge.textContent = statusLabel(st);
	});
}


// ------------------------------------------------------------
// Ownership: richiesta/autorizzazione presa in carico
// - Se una comanda e' gia' in carico ad un'altra postazione ONLINE,
//   chi la vuole prendere deve inviare richiesta e attendere autorizzazione.
// - Se la postazione proprietaria e' in PAUSA, il trasferimento avviene
//   automaticamente e viene registrata una notifica valida 60 minuti.
// - Il trasferimento e' valido solo per comande IN PREPARAZIONE, oppure
//   anche IN ATTESA se abilitato dal server (SERVER_FLAGS.allowTransferWaiting).
// ------------------------------------------------------------
function canRequestTransferForOrder(order) {
	const st = computeStatus(order);
	if (st === "prep") return true;
	if (st === "new" && SERVER_FLAGS.allowTransferWaiting) return true;
	return false;
}

function notifyOwnerStationAutoTransfer(ownerStation, orderId, newOwnerStation) {
	queuePauseNotification(ownerStation,
		`La comanda <strong>#${orderId}</strong> e' stata trasferita automaticamente a <strong>${newOwnerStation}</strong> perche' la postazione era in pausa.`);
}

function autoTakeoverFromPausedOwner(order) {
	if (!order || !order.ownerStation) return false;
	if (order.ownerStation === state.stationName) return true;
	if (isStationOnline(order.ownerStation)) return false;

	const from = order.ownerStation;
	setOwner(order, state.stationName);
	notifyOwnerStationAutoTransfer(from, order.id, state.stationName);
	toast(`Comanda #${order.id} trasferita automaticamente (owner in pausa)`);
	void syncOrderToBackend(order);
	return true;
}

function requestTakeover(order) {
	if (!order) return false;
	if (!order.ownerStation || order.ownerStation === state.stationName) return true;

	if (!canRequestTransferForOrder(order)) {
		toast("Trasferimento non consentito per comande in attesa");
		return false;
	}

	// Se la postazione proprietaria e' in pausa, prendo in carico automaticamente.
	if (autoTakeoverFromPausedOwner(order)) {
		return true;
	}

	// Richiesta: DEVE autorizzare la postazione proprietaria.
	// La conferma va mostrata SOLO alla postazione owner (quando visualizza la UI),
	// non a chi sta facendo la richiesta.
	if (order.pendingAuthRequest && order.pendingAuthRequest.mode === "takeover") {
		toast(`Richiesta gia' inviata a ${order.ownerStation} per la comanda #${order.id}`);
		return false;
	}

	order.pendingAuthRequest = {
		orderId: order.id,
		fromStation: order.ownerStation, // owner che deve approvare
		toStation: state.stationName,    // richiedente
		toOperator: state.loggedIn ? state.userName : "Guest",
		requestedAtMs: nowMs(),
		mode: "takeover",
		shownToOwner: false
	};

	toast(`Richiesta inviata a ${order.ownerStation} (comanda #${order.id})`);
	return false;
}

function maybeSwitchPrepTo(order) {
	if (!order) return;
	const currentStatus = computeStatus(order);
	if (currentStatus === "done" || currentStatus === "ready") return;

	// Se e' gia' in carico ad un'altra postazione, devo richiederla.
	if (order.ownerStation && order.ownerStation !== state.stationName) {
		const ok = requestTakeover(order);
		if (!ok) return;
	}

	const currentPrep = getCurrentPrepOrder();
	if (!currentPrep) {
		order.workflowStatus = "prep";
		setOwner(order, state.stationName);
		void syncOrderToBackend(order);
		return;
	}
	if (currentPrep.id === order.id) return;

	const currentDoneCount = currentPrep.items.filter(i => i.done).length;
	if (currentDoneCount === 0) {
		currentPrep.workflowStatus = "waiting";
		// Se la comanda torna libera (nessuna spunta), rimuovo l'owner.
		releaseOwner(currentPrep);
		order.workflowStatus = "prep";
		setOwner(order, state.stationName);
		void syncOrderToBackend(currentPrep);
		void syncOrderToBackend(order);
		return;
	}

	// blocco: non posso spostare la preparazione perche' la comanda in corso ha gia' spunte
	toast(`Comanda #${currentPrep.id} gia' in preparazione (con spunte)`);
}

function renderOrdersFull() {
	const listEl = $("ordersList");
	if (!listEl) return;
	const prevScroll = listEl.scrollTop;

	listEl.innerHTML = "";
	let visible = sortOrders(getVisibleOrdersForStation());
	// Compat robusta:
	// 1) se il filtro non trova nulla ma ci sono attive, mostro comunque le attive;
	// 2) se la cache/client marca tutto come "done" in modo errato, mostro comunque lo storico.
	if (!visible.length && orders.length > 0) {
		const nonDelivered = orders.filter(o => !isAlwaysHiddenForPostazioneStatus(computeStatus(o)));
		const active = nonDelivered.filter(o => !isArchivedForPostazioneStatus(computeStatus(o)));
		visible = sortOrders(state.showDone ? nonDelivered : active);
	}
	if (!visible.length) {
		const info = (typeof window !== "undefined" && window.__postazioneOrdersSync)
			? window.__postazioneOrdersSync
			: null;
		const empty = document.createElement("div");
		empty.className = "order-card";
		empty.style.padding = "12px";
		empty.style.color = "var(--text-secondary)";
		empty.style.fontWeight = "800";
		empty.style.border = "1px dashed rgba(255,255,255,.16)";
		if (orders.length > 0) {
			const sourceInfo = info && info.apiBase ? ` API: ${info.apiBase}` : "";
			const activeCount = orders.filter(o => {
				const st = computeStatus(o);
				return !isAlwaysHiddenForPostazioneStatus(st) && !isArchivedForPostazioneStatus(st);
			}).length;
			empty.textContent = `Nessuna comanda visibile con i filtri correnti (totali: ${orders.length}, attive: ${activeCount}).${sourceInfo}`;
		} else if (info && info.ok === false) {
			const sourceInfo = info && info.apiBase ? ` API: ${info.apiBase}` : "";
			empty.textContent = `Sync backend non disponibile (controlla API/postazione).${sourceInfo}`;
		} else {
			empty.textContent = "Nessuna comanda in arrivo.";
		}
		listEl.appendChild(empty);
	}

	visible.forEach(o => {
		const st = computeStatus(o);
		const stripClass = st === "new" ? "st-new" : st === "prep" ? "st-prep" : st === "ready" ? "st-ready" : "st-done";
		const badgeClass = st === "new" ? "bg-new" : st === "prep" ? "bg-prep" : st === "ready" ? "bg-ready" : "bg-done";
		const tableLabel = buildOrderTableLabel(o);
		const roomLabel = buildOrderRoomLabel(o);

		const lockedByOther = !!(o.ownerStation && o.ownerStation !== state.stationName && isStationOnline(o.ownerStation));
		const card = document.createElement("div");
		card.className = "order-card" + (o.id === state.selectedOrderId ? " selected" : "") + (lockedByOther ? " locked" : "");
		card.dataset.orderId = o.id;

		card.innerHTML = `
			<div class="status-strip ${stripClass}"></div>
			<div class="card-header">
				<span>TAVOLO: ${tableLabel}</span>
				<span class="card-right">${lockedByOther ? '<i class="fa-solid fa-lock" title="In carico ad altra postazione"></i>' : ''} #${o.id}</span>
			</div>
			<div class="card-body">
				<div>Sala: ${roomLabel || "-"}</div>
				<div>Cam: ${o.waiter}</div>
				<div style="margin-top:2px;">In carico: <strong>${ownerLabel(o)}</strong></div>
				<span class="status-badge ${badgeClass}">${statusLabel(st)}</span>
				<span class="timer">--:--</span>
				<div>Coperti: ${o.covers} | Apericena: ${o.apericena}</div>
			</div>
		`;

		card.addEventListener("click", () => {
			if (!state.stationActive) {
				toast("Postazione in pausa");
				return;
			}

			state.selectedOrderId = o.id;
			maybeSwitchPrepTo(o);
			renderOrdersFull();
			updateSelectedCard();
			renderDetails();
			void syncOrderToBackend(o);
		});

		listEl.appendChild(card);
	});

	listEl.scrollTop = prevScroll;
	updateOrdersTimersAndStatus();
}

function setActionsEnabled(canUse, canReady, canTransfer) {
	$("btnCall").disabled = !canUse;
	// Stampa: deve rimanere disponibile quando esiste una comanda selezionata
	// (l'overlay PAUSA blocca comunque l'interazione sul pannello principale).
	$("btnPrint").disabled = false;
	$("btnReady").disabled = !(canUse && canReady);
	const bt = $("btnTransfer");
	if (bt) bt.disabled = !(canUse && canTransfer);
}

function renderDetails() {
	const o = getOrderById(state.selectedOrderId);
	if (!o) {
		$("dTable").textContent = "-";
		$("dRoom").textContent = "-";
		$("dWaiter").textContent = "-";
		$("dOrder").textContent = "-";
		$("dTimer").textContent = "-";
		$("itemList").innerHTML = `<div style="color:var(--text-secondary); font-weight:850; padding:10px 0;">Seleziona una comanda a sinistra.</div>`;
		$("sCovers").textContent = "-";
		$("sAperi").textContent = "-";
		$("sItems").textContent = "-";
		$("sNotes").style.display = "none";
		setActionsEnabled(false, false, false);
		$("btnPrint").disabled = true;
		return;
	}

	const st = computeStatus(o);
	const isDone = (st === "done");
	const isReady = (st === "ready");
	const transferredOut = (o.station !== state.stationName) && (o.transferredFromStation === state.stationName);
	const elapsed = getOrderElapsedMs(o);
	const prep = getCurrentPrepOrder();
	const prepLocked = !!(prep && prep.id !== o.id && prep.items.some(i => i.done));
	const tableLabel = buildOrderTableLabel(o);
	const roomLabel = buildOrderRoomLabel(o);

	$("dTable").textContent = tableLabel;
	$("dRoom").textContent = roomLabel || "-";
	$("dWaiter").textContent = o.waiter;
	$("dOrder").textContent = `#${o.id}`;
	$("dTimer").textContent = fmtMMSS(elapsed);

	const list = $("itemList");
	list.innerHTML = "";

	const disabledByFlow =
		(!state.stationActive) ||
		isDone ||
		isReady ||
		prepLocked ||
		transferredOut ||
		(normalizeOrderWorkflowStatus(o.workflowStatus) !== "prep" && !!prep && prep.id !== o.id && prep.items.some(i => i.done));

	if (prepLocked) {
		const hint = document.createElement("div");
		hint.className = "inline-hint";
		hint.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> C'e gia una comanda in preparazione (#${prep.id}) con articoli spuntati. Questa rimane in attesa.`;
		list.appendChild(hint);
	}

	// Raggruppamento righe per (nome + variante + note)
	const groups = new Map();
	o.items.forEach(it => {
		const name = String(it.name || "");
		const variant = String(it.variant || "").trim();
		const note = String(it.note || "").trim();
		const key = `${keyName(name)}|${keyName(variant)}|${keyName(note)}`;
		const g = groups.get(key) || { name, variant, note, items: [] };
		g.items.push(it);
		groups.set(key, g);
	});

	// Stabile: prima per nome, poi variante, poi note
	const grouped = Array.from(groups.values()).sort((a,b) =>
		a.name.localeCompare(b.name,'it',{sensitivity:'base'})
		|| a.variant.localeCompare(b.variant,'it',{sensitivity:'base'})
		|| a.note.localeCompare(b.note,'it',{sensitivity:'base'})
	);

	grouped.forEach((g) => {
		const row = document.createElement("div");
		const anyOutOfStock = g.items.some(x => isOrderItemDisabled(x, state.stationName));
		row.className = "order-item" + (anyOutOfStock ? " out-of-stock" : "");

		const rowDisabled = disabledByFlow || anyOutOfStock;
		const qty = g.items.length;
		const doneCount = g.items.filter(x => x.done).length;
		const allDone = doneCount === qty;
		const anyDone = doneCount > 0;

		row.innerHTML = `
			<label class="check-container" style="${rowDisabled ? "opacity:.65; cursor:not-allowed;" : ""}">
				<input type="checkbox" ${allDone ? "checked" : ""} ${rowDisabled ? "disabled" : ""}>
				<span class="checkmark"></span>
			</label>
			<div class="item-qty">${qty}</div>
			<div class="item-name">${String(g.name).toUpperCase()}${anyOutOfStock ? ` <span class=\"tag-ooo\">TERMINATO</span>` : ""}</div>
			<div class="item-variant">${g.variant ? `<span class=\"variant-pill\"><em>${String(g.variant)}</em></span>` : "-"}</div>
			<div class="item-notes">${(g.note && g.note.trim()) ? g.note.toUpperCase() : "N/A"}</div>
		`;

		const cb = row.querySelector("input[type=checkbox]");
		// Stato intermedio (alcuni spuntati)
		if (!allDone && anyDone) cb.indeterminate = true;

		cb.addEventListener("change", () => {
			if (rowDisabled) {
				cb.checked = allDone;
				cb.indeterminate = (!allDone && anyDone);
				if (anyOutOfStock) toast("Articolo terminato");
				return;
			}
			const newVal = cb.checked;
			g.items.forEach(it => {
				it.done = newVal;
				// Scalatura magazzino per articoli temporanei (se qty impostata)
				const temp = getTempItemByName(it.name);
				if (temp && temp.qtyRemaining != null) {
					if (it.done && !it.stockDebited) {
						temp.qtyRemaining = Math.max(0, Number(temp.qtyRemaining) - 1);
						it.stockDebited = true;
						if (Number(temp.qtyRemaining) <= 0) {
							protectExistingOrderLinesFromDisable(it.name, null);
						}
						saveTempItems(tempMenuItems);
					}
					if (!it.done && it.stockDebited) {
						temp.qtyRemaining = Number(temp.qtyRemaining) + 1;
						it.stockDebited = false;
						saveTempItems(tempMenuItems);
					}
				}
			});

			// se tutte fatte -> completa (escludo le righe non disponibili per questa postazione)
			const stn = o.station || state.stationName;
			const effective = o.items.filter(x => !isOrderItemDisabled(x, stn));
			const total = effective.length;
			const doneTot = effective.filter(x => x.done).length;
			if (total > 0 && doneTot === total) {
				o.workflowStatus = "ready";
				o.completedAtMs = null;
				toast(`Comanda #${o.id} da ritirare`);
			} else if (doneTot > 0) {
				o.workflowStatus = "prep";
				o.completedAtMs = null;
			} else {
				o.workflowStatus = "waiting";
				o.completedAtMs = null;
			}

			renderOrdersFull();
			updateSelectedCard();
			renderDetails();
		});

		list.appendChild(row);
	});

	$("sCovers").textContent = String(o.covers);
	$("sAperi").textContent = String(o.apericena);
	$("sItems").textContent = String(o.items.length);

	if (o.note && o.note.trim()) {
		$("sNotesText").textContent = o.note.toUpperCase();
		$("sNotes").style.display = "block";
	} else {
		$("sNotes").style.display = "none";
	}

	if (o.communications && String(o.communications).trim()) {
		$("sCommsText").textContent = String(o.communications).toUpperCase();
		$("sComms").style.display = "block";
	} else {
		$("sComms").style.display = "none";
	}

	// Azioni
	if (transferredOut) {
		// Comanda trasferita ad altra postazione: niente azioni locali, solo richiesta rientro (se consentito)
		state.callMode = "recall";
		$("btnCall").textContent = "RICHIEDI INDIETRO";
		const canRecall = computeStatus(o) === "new";
		$("btnCall").disabled = !canRecall;
		$("btnReady").disabled = true;
		$("btnTransfer").disabled = true;
		$("btnReady").style.display = "none";
		$("btnTransfer").style.display = "none";
		// Stampa sempre disponibile
		$("btnPrint").disabled = false;
	} else {
		state.callMode = "waiter";
		$("btnCall").textContent = "CAMERIERE";
		const canActOnOrder = !isDone && !isReady;
		setActionsEnabled(state.stationActive, canActOnOrder, canActOnOrder);
		$("btnReady").style.display = canActOnOrder ? "flex" : "none";
		// Il pulsante TRASFERISCI non deve essere visibile sulle comande PRONTE/CHIUSE.
		$("btnTransfer").style.display = canActOnOrder ? "flex" : "none";
	}
}

function getActiveOperatorName() {
	const name = String(state.userName || "").trim();
	if (state.loggedIn && name && name.toLowerCase() !== "guest") return name;
	return name || "Guest";
}

function resolveWaiterIdentity(waiterRef) {
	if (waiterRef && typeof waiterRef === "object") {
		const name = String(waiterRef.name || waiterRef.fullName || waiterRef.username || "").trim();
		return {
			name,
			username: String(waiterRef.username || "").trim(),
			userId: String(waiterRef.userId || "").trim(),
			clientApp: String(waiterRef.clientApp || "mobile-frontend").trim()
		};
	}

	const rawName = String(waiterRef || "").trim();
	if (!rawName) return { name: "", username: "", userId: "" };
	const key = rawName.toLowerCase();
	const mapped = Array.isArray(WAITERS)
		? WAITERS.find((item) => {
			const fullName = String(item?.name || "").trim().toLowerCase();
			const username = String(item?.username || "").trim().toLowerCase();
			const firstName = fullName.split(/\s+/).filter(Boolean)[0] || "";
			return fullName === key || username === key || firstName === key;
		})
		: null;

	if (mapped) {
		return {
			name: String(mapped.name || rawName).trim(),
			username: String(mapped.username || "").trim(),
			userId: String(mapped.userId || "").trim(),
			clientApp: String(mapped.clientApp || "mobile-frontend").trim()
		};
	}

	return { name: rawName, username: "", userId: "", clientApp: "mobile-frontend" };
}

function buildWaiterNotificationContext(order, waiterRef) {
	const stationName = String(state.stationName || "POSTAZIONE").trim() || "POSTAZIONE";
	const operatorName = getActiveOperatorName();
	const waiterIdentity = resolveWaiterIdentity(waiterRef);
	const safeWaiter = waiterIdentity.name;
	const roomLabel = order ? buildOrderRoomLabel(order) : "";
	const tableLabel = order ? buildOrderTableLabel(order) : "";
	const tablePart = order
		? ` - Tavolo ${tableLabel}${roomLabel ? ` (${roomLabel})` : ""} - comanda #${order.id}`
		: "";
	const waiterPart = safeWaiter ? ` - Cameriere: ${safeWaiter}` : "";

	return {
		title: stationName,
		description: `Richiesta da ${operatorName}${waiterPart}${tablePart}`,
		meta: {
			station: stationName,
			requestedBy: operatorName,
			requestedByRole: String(state.userRole || "Non autenticato"),
			waiter: safeWaiter,
			targetUsername: waiterIdentity.username,
			targetUserId: waiterIdentity.userId,
			targetFullName: safeWaiter,
			targetClientApp: waiterIdentity.clientApp || "mobile-frontend"
		}
	};
}

function renderWaiters() {
	const w = $("waiterButtons");
	w.innerHTML = "";
	if (!Array.isArray(WAITERS) || WAITERS.length === 0) {
		const empty = document.createElement("div");
		empty.style.color = "var(--text-secondary)";
		empty.style.fontWeight = "800";
		empty.style.padding = "8px 0";
		empty.textContent = "Nessun cameriere loggato";
		w.appendChild(empty);
		return;
	}
	WAITERS.forEach(x => {
		const btn = document.createElement("div");
		btn.className = "waiter-circle";
		btn.innerHTML = `
			<div class="waiter-left">
				<div class="waiter-badge">${x.id}</div>
				<div class="waiter-name">${x.name}</div>
			</div>
		`;
		btn.addEventListener("click", () => {
			toast(`Chiamo ${x.name}`);
			const o = getOrderById(state.selectedOrderId);
			const notification = buildWaiterNotificationContext(o, x);
			void publishIntegrationNotification(
				"waiter",
				notification.title,
				notification.description,
				o
					? {
						...notification.meta,
						table: o.table,
						tableNumber: o.tableNumber || o.table,
						tableId: o.tableId || "",
						roomId: o.roomId || "",
						roomName: buildOrderRoomLabel(o),
						orderId: o.id
					}
					: { ...notification.meta }
			);
		});
		w.appendChild(btn);
	});
}

function printOrder(order) {
	const elapsed = getOrderElapsedMs(order);
	const tableLabel = buildOrderTableLabel(order);
	const roomLabel = buildOrderRoomLabel(order);
	const lines = order.items.map(it => {
		const v = (it.variant && String(it.variant).trim()) ? ` - ${String(it.variant).trim()}` : '';
		const n = (it.note && String(it.note).trim()) ? String(it.note).trim() : 'N/A';
		return `${it.name}${v}\t${n}`;
	}).join("\n");
	const w = window.open("", "_blank");
	w.document.write(`<pre style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas; padding:18px">
POSTAZIONE: ${state.stationName}
TAVOLO: ${tableLabel}
SALA: ${roomLabel || "N/A"}
CAMERIERE: ${order.waiter}
COMANDA: #${order.id}
TIMER: ${fmtMMSS(elapsed)}

${lines}

NOTE: ${order.note || "N/A"}

COMUNICAZIONI: ${order.communications || "N/A"}
</pre>`);
	w.document.close();
	w.focus();
}

function printPreconto(order) {
	const elapsed = getOrderElapsedMs(order);
	const tableLabel = buildOrderTableLabel(order);
	const roomLabel = buildOrderRoomLabel(order);
	const rows = order.items.map(it => {
		const p = menuPriceFor(it.name);
		const price = (typeof p === "number" && !Number.isNaN(p)) ? p : null;
		return { name: it.name, price };
	});
	const total = rows.reduce((acc, r) => acc + (r.price || 0), 0);
	const body = rows.map(r => {
		const p = (r.price == null) ? "-" : `${r.price.toFixed(2)} EUR`;
		return `${r.name}\t${p}`;
	}).join("\n");

	const w = window.open("", "_blank");
	w.document.write(`<pre style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas; padding:18px">
PRECONTO\n
POSTAZIONE: ${state.stationName}
TAVOLO: ${tableLabel}
SALA: ${roomLabel || "N/A"}
CAMERIERE: ${order.waiter}
COMANDA: #${order.id}
TIMER: ${fmtMMSS(elapsed)}\n
${body}\n
TOTALE: ${total.toFixed(2)} EUR
</pre>`);
	w.document.close();
	w.focus();
}

function openPrintModal() {
	const o = getOrderById(state.selectedOrderId);
	if (!o) { toast("Seleziona una comanda"); return; }
	const m = $("printModal");
	if (!m) return;
	m.classList.add("show");
	m.setAttribute("aria-hidden", "false");
}

function closePrintModal() {
	const m = $("printModal");
	if (!m) return;
	// Evito aria-hidden su elemento che mantiene focus
	if (document.activeElement && typeof document.activeElement.blur === "function") document.activeElement.blur();
	m.classList.remove("show");
	m.setAttribute("aria-hidden", "true");
}

function doPrintSelected(kind) {
	const o = getOrderById(state.selectedOrderId);
	if (!o) return;
	if (kind === "preconto") {
		printPreconto(o);
		toast("Preconto pronto");
		return;
	}
	printOrder(o);
	toast("Comanda pronta");
}

// ------------------------------------------------------------
// Trasferimento comande
// ------------------------------------------------------------
function openTransferModal() {
	const o = getOrderById(state.selectedOrderId);
	if (!o) { toast("Seleziona una comanda"); return; }
	if (!state.stationActive) { toast("Postazione in pausa"); return; }
	if (computeStatus(o) === "done") { toast("Comanda gia terminata"); return; }
	const __st = computeStatus(o);
	if (__st === "ready") { toast("Comanda gia' da ritirare"); return; }
	if (__st === "new" && !SERVER_FLAGS.allowTransferWaiting) {
		toast("Trasferimento non abilitato per comande in attesa");
		return;
	}

	updateStationsSelf();
	state.pendingTransferTarget = null;
	$("btnTransferApply").disabled = true;

	const grid = $("transferStations");
	grid.innerHTML = "";

	stationsState.forEach(st => {
		if (st.name === state.stationName) return;
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "station-tile";
		btn.disabled = !st.active;
		btn.innerHTML = `
			<div class="tile-name">${st.name}</div>
			<div class="tile-sub">Operatore: <strong>${st.operatorName}</strong></div>
			<div class="tile-sub">Stato: <strong>${st.active ? "ONLINE" : "PAUSA"}</strong></div>
		`;
		btn.addEventListener("click", () => {
			if (!st.active) return;
			state.pendingTransferTarget = st.name;
			$("btnTransferApply").disabled = false;
			// highlight
			grid.querySelectorAll(".station-tile").forEach(x => x.classList.remove("selected"));
			btn.classList.add("selected");
			const hint = $("transferSelectionHint");
			hint.style.display = "block";
			hint.innerHTML = `Destinazione selezionata: <strong>${st.name}</strong>  -  Operatore: <strong>${st.operatorName}</strong>`;
		});
		grid.appendChild(btn);
	});

	$("transferModal").classList.add("show");
	$("transferModal").setAttribute("aria-hidden", "false");
}

function closeTransferModal() {
	$("transferModal").classList.remove("show");
	$("transferModal").setAttribute("aria-hidden", "true");
	state.pendingTransferTarget = null;
}

function applyTransfer() {
	const o = getOrderById(state.selectedOrderId);
	if (!o) return;

	// Solo chi ha la comanda in carico puo' trasferirla ad un altro bar.
	if (o.ownerStation && o.ownerStation !== state.stationName) {
		toast(`Comanda in carico a ${o.ownerStation}: richiedi prima la presa in carico`);
		requestTakeover(o);
		return;
	}

	const st = computeStatus(o);
	if (st === "done" || st === "ready") {
		toast("Comanda gia' da ritirare");
		return;
	}
	if (st === "new" && !SERVER_FLAGS.allowTransferWaiting) {
		toast("Trasferimento non abilitato per comande in attesa");
		return;
	}

	const target = state.pendingTransferTarget;
	if (!target) { toast("Seleziona una postazione"); return; }

	const targetState = stationsState.find(x => x.name === target);
	if (!targetState || !targetState.active) {
		toast("Postazione non selezionabile");
		return;
	}

	// Flusso: la postazione DEST chiede la comanda; l'owner attuale deve autorizzare.
	// Trasferimento richiesto dall'owner corrente: avviene subito (nessuna conferma locale).
	const prevStation = o.station;
	if (o.station !== target) {
		o.station = target;
		// quando cambia bar, riparte in attesa
		o.workflowStatus = "waiting";
	}

	o.ownerStation = target;
	o.ownerOperator = targetState.operatorName;
	o.ownerRole = targetState.operatorRole || "Operatore";
	o.ownerAtMs = nowMs();

	closeTransferModal();
	toast(`Comanda #${o.id} trasferita a ${target}`);

	// Se la comanda e' uscita dalla mia postazione, ricalcolo prep automatico.
	if (prevStation === state.stationName && o.station !== state.stationName) {
		ensureAutoPrep();
	}
	ensureSelection();
	renderOrdersFull();
	updateSelectedCard();
	renderDetails();
}

function openAuthModal() {
	const p = state.pendingAuth;
	if (!p) return;
	const mode = p.mode || "transfer";

	if (mode === "takeover") {
		$("authText").innerHTML = `La postazione <strong>${p.toStation}</strong> (operatore: <strong>${p.toOperator}</strong>) richiede di prendere in carico la comanda <strong>#${p.orderId}</strong> attualmente in carico a <strong>${p.fromStation}</strong>.<br><br>Vuoi autorizzare il trasferimento?`;
	} else {
		$("authText").innerHTML = `La postazione <strong>${p.toStation}</strong> (operatore: <strong>${p.toOperator}</strong>) richiede la comanda <strong>#${p.orderId}</strong>.<br><br>Vuoi autorizzare il trasferimento?`;
	}

	$("authModal").classList.add("show");
	$("authModal").setAttribute("aria-hidden", "false");
}
function closeAuthModal() {
	$("authModal").classList.remove("show");
	$("authModal").setAttribute("aria-hidden", "true");
}

function denyAuth() {
	const p = state.pendingAuth;
	closeAuthModal();
	state.pendingAuth = null;
	// Se sto negando una richiesta, la rimuovo dalla comanda.
	if (p) {
		const o = getOrderById(p.orderId);
		if (o) o.pendingAuthRequest = null;
	}
	if (p) toast(`Trasferimento negato (comanda #${p.orderId})`);
}

function approveAuth() {
	const p = state.pendingAuth;
	if (!p) { closeAuthModal(); return; }
	const o = getOrderById(p.orderId);
	if (!o) { closeAuthModal(); state.pendingAuth = null; return; }
	// Richiesta consumata
	o.pendingAuthRequest = null;

	// Consumo la richiesta.
	o.pendingAuthRequest = null;

	const prevStation = o.station;
	const mode = p.mode || "transfer";

	// Se e' un trasferimento di BAR (postazione diversa), sposto la comanda.
	if (mode === "transfer" && o.station !== p.toStation) {
		o.station = p.toStation;
		// quando cambia bar, riparte in attesa
		o.workflowStatus = "waiting";
	}

	// Ownership passa alla destinazione (sempre).
	o.ownerStation = p.toStation;
	o.ownerOperator = p.toOperator;
	o.ownerRole = (stationsState.find(x => x.name === p.toStation)?.operatorRole) || "Operatore";
	o.ownerAtMs = nowMs();

	closeAuthModal();
	state.pendingAuth = null;
	toast(`Comanda #${o.id} trasferita a ${p.toStation}`);

	// Se la comanda e' uscita dalla mia postazione, ricalcolo prep automatico.
	if (prevStation === state.stationName && o.station !== state.stationName) {
		ensureAutoPrep();
	}

	ensureSelection();
	renderOrdersFull();
	updateSelectedCard();
	renderDetails();
}

// ------------------------------------------------------------
// Notifiche post-pausa (60 minuti)
// ------------------------------------------------------------
function queuePauseNotification(stationName, message) {
	(pauseNotifications[stationName] ||= []).push({
		message,
		expiresAtMs: nowMs() + 60 * 60 * 1000,
		shown: false
	});
}

function popNextNotificationForCurrentStation() {
	const list = pauseNotifications[state.stationName] || [];
	const t = nowMs();
	const hit = list.find(n => !n.shown && n.expiresAtMs > t);
	if (!hit) return null;
	hit.shown = true;
	return hit.message;
}

function openNotifyModal(msg) {
	state.pendingNotify = msg;
	$("notifyText").innerHTML = String(msg);
	$("notifyModal").classList.add("show");
	$("notifyModal").setAttribute("aria-hidden", "false");
}

function closeNotifyModal() {
	$("notifyModal").classList.remove("show");
	$("notifyModal").setAttribute("aria-hidden", "true");
}

function ackNotify() {
	closeNotifyModal();
	state.pendingNotify = null;
}

// ------------------------------------------------------------
// Catalogo articoli + disabilitazione
// ------------------------------------------------------------
function getCatalogItemsForCurrentStation() {
	// Mostro gli articoli che possono essere preparati da questa postazione (menu base + temporanei)
	const names = new Set();
	getAllMenuItems().forEach(it => {
		if (Array.isArray(it.stations) && it.stations.includes(state.stationName)) names.add(it.name);
	});

	// includo anche articoli eventualmente presenti nelle comande (se non sono nel menu)
	orders.forEach(o => {
		if (o.station !== state.stationName) return;
		o.items.forEach(it => {
			if (!it || !it.name) return;
			const st = menuStationsFor(it.name);
			if (st.includes(state.stationName)) names.add(it.name);
		});
	});

	return [...names].sort((a, b) => a.localeCompare(b, 'it', {sensitivity:'base'}));
}

function fmtPrice(p) {
	if (p == null || Number.isNaN(p)) return "-";
	return Number(p).toFixed(2);
}

function renderCatalog() {
	const wrap = $("catalogList");
	wrap.innerHTML = "";
	const q = keyName(state.catalogQuery);
	const items = getCatalogItemsForCurrentStation()
		.filter(name => !q || keyName(name).includes(q));

	function categoryFor(meta, name) {
		if (meta && meta.isTemp) return "Temporanei";
		const stations = menuStationsFor(name);
		const n = keyName(name);
		if (stations.includes("CAFFETTERIA") || n.includes("caffe") || n.includes("cappu") || n.includes("cornetto")) return "Caffetteria";
		if (n.includes("birra")) return "Birre";
		if (n.includes("analcol")) return "Analcolici";
		return "Cocktail / Drink";
	}

	const groups = {};
	items.forEach(name => {
		const meta = findMenuItemByName(name);
		const cat = categoryFor(meta, name);
		(groups[cat] ||= []).push(name);
	});

	const catOrder = ["Temporanei", "Cocktail / Drink", "Analcolici", "Birre", "Caffetteria"];
	const cats = Object.keys(groups).sort((a,b) => {
		const ia = catOrder.indexOf(a);
		const ib = catOrder.indexOf(b);
		return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.localeCompare(b,'it',{sensitivity:'base'});
	});

	function makeRow(name) {
		const meta = findMenuItemByName(name);
		const variants = (meta && Array.isArray(meta.variants))
			? meta.variants.map(v => String(v).trim()).filter(v => v.length > 0)
			: [];
		const variantsHtml = variants.length ? ` <em class="item-variants">${variants.join(' / ')}</em>` : '';
		const stations = menuStationsFor(name);
		const multi = stations.length > 1;
		const disabledHere = isItemDisabledForStation(name, state.stationName);
		const disabledEverywhere = disabledGlobal.has(keyName(name));
		const price = menuPriceFor(name);
		const availability = stations.join(", ");
		const status = disabledEverywhere ? "DISATTIVO (TUTTE)" : (disabledHere ? "DISATTIVO (QUI)" : "ATTIVO");
		const isTemp = !!(meta && meta.isTemp);
		const qtyLabel = (isTemp && meta && meta.qtyRemaining != null) ? ` - QTA: ${meta.qtyRemaining}` : '';
		const row = document.createElement('div');
		row.className = 'catalog-row-grid';
		row.innerHTML = `
			<div class="catalog-cell">
				<div class="catalog-name">${String(name).toUpperCase()}${variantsHtml}</div>
				<div class="catalog-sub">${isTemp ? `Temporaneo${qtyLabel}` : 'Listino'}</div>
			</div>
			<div class="catalog-cell catalog-avail">${availability}</div>
			<div class="catalog-cell catalog-price">${fmtPrice(price)}</div>
			<div class="catalog-cell"><span class="pill ${disabledHere||disabledEverywhere ? 'pill-warn' : 'pill-ok'}">${status}</span></div>
			<div class="catalog-cell catalog-actions">
				<button class="small-btn ${disabledHere||disabledEverywhere ? 'success' : 'danger'}" data-act="toggle" data-item="${String(name)}">${disabledHere||disabledEverywhere ? 'ATTIVA' : 'DISATTIVA'}</button>
				${isTemp ? `<button class="small-btn" data-act="edit" data-item="${String(name)}">MODIFICA</button>
				<button class="small-btn danger" data-act="delete" data-item="${String(name)}">RIMUOVI</button>` : ''}
			</div>
		`;

		row.querySelectorAll('button').forEach(b => {
			b.addEventListener('click', () => {
				const act = b.getAttribute('data-act');
				const item = b.getAttribute('data-item');
				if (!act || !item) return;
				if (act === 'toggle') {
					if (disabledHere || disabledEverywhere) {
						// riattiva
						disabledGlobal.delete(keyName(item));
						(disabledLocal[state.stationName] ||= new Set()).delete(keyName(item));
						persistDisabledState();
						queueAction({ type:'item_enable', itemName:item, scope:'station', station:state.stationName });
						toast(`Articolo attivo: ${item}`);
						renderCatalog();
						renderDetails();
						return;
					}
					// disabilita
					if (multi) {
						state.pendingDisableItem = item;
						openScopeModal(item);
					} else {
						(disabledLocal[state.stationName] ||= new Set()).add(keyName(item));
						persistDisabledState();
						queueAction({ type:'item_disable', itemName:item, scope:'station', station:state.stationName });
						// Se terminato solo qui e disponibile altrove, inoltra automaticamente un parziale.
						forwardPartialOrdersForLocalOutOfStock(item);
						toast(`Terminato: ${item}`);
						renderCatalog();
						renderDetails();
					}
					return;
				}
				if (act === 'edit') { openTempItemModal(item); return; }
				if (act === 'delete') { state.editingTempName = item; deleteTempItem(); return; }
			});
		});
		return row;
	}

	cats.forEach(cat => {
		const block = document.createElement('div');
		block.className = 'cat-block';
		const open = state.catalogOpenCats[cat] ?? (q ? true : false);
		if (open) block.classList.add('open');
		block.innerHTML = `
			<div class="cat-head" data-cat="${cat}">
				<div class="cat-title">${cat}</div>
				<div class="cat-meta"><span>${groups[cat].length} articoli</span><i class="fa-solid fa-chevron-down"></i></div>
			</div>
			<div class="cat-items"></div>
		`;
		const itemsWrap = block.querySelector('.cat-items');
		groups[cat].sort((a,b) => a.localeCompare(b,'it',{sensitivity:'base'})).forEach(name => {
			itemsWrap.appendChild(makeRow(name));
		});
		block.querySelector('.cat-head').addEventListener('click', () => {
			const isOpen = block.classList.toggle('open');
			state.catalogOpenCats[cat] = isOpen;
		});
		wrap.appendChild(block);
	});
}

function openCatalogModal() {
	renderCatalog();
	$("catalogModal").classList.add("show");
	$("catalogModal").setAttribute("aria-hidden", "false");
}

function closeCatalogModal() {
	$("catalogModal").classList.remove("show");
	$("catalogModal").setAttribute("aria-hidden", "true");
}

function openScopeModal(itemName) {
	$("scopeText").textContent = `Articolo: ${String(itemName).toUpperCase()}\nScegli se e terminato SOLO per questa postazione o per TUTTE.`;
	$("scopeModal").classList.add("show");
	$("scopeModal").setAttribute("aria-hidden", "false");
}

function closeScopeModal() {
	$("scopeModal").classList.remove("show");
	$("scopeModal").setAttribute("aria-hidden", "true");
	state.pendingDisableItem = null;
}

function disableItemScope(scope) {
	const name = state.pendingDisableItem;
	if (!name) { closeScopeModal(); return; }
	const k = keyName(name);
	if (scope === "global") {
		disabledGlobal.add(k);
		persistDisabledState();
		queueAction({ type:'item_disable', itemName:name, scope:'global' });
		// L'articolo deve restare selezionabile nelle comande gia create.
		protectExistingOrderLinesFromDisable(name, null);
		toast(`Terminato per tutte: ${name}`);
	} else {
		(disabledLocal[state.stationName] ||= new Set()).add(k);
		persistDisabledState();
		queueAction({ type:'item_disable', itemName:name, scope:'station', station:state.stationName });
		// L'articolo deve restare selezionabile nelle comande gia create su questa postazione.
		protectExistingOrderLinesFromDisable(name, state.stationName);
		toast(`Terminato qui: ${name}`);
	}
	closeScopeModal();
	renderCatalog();
	renderDetails();
}



// ------------------------------------------------------------
// Articoli temporanei (CRUD) - visibili da tutte le postazioni
// ------------------------------------------------------------
function openTempItemModal(itemNameOrNull) {
	state.editingTempName = itemNameOrNull ? String(itemNameOrNull) : null;
	const editing = state.editingTempName ? tempMenuItems.find(x => keyName(x.name) === keyName(state.editingTempName)) : null;
	$("tempItemName").value = editing ? editing.name : "";
	$("tempItemPrice").value = editing && typeof editing.price === 'number' && !Number.isNaN(editing.price) ? String(editing.price.toFixed(2)) : "";
	const qEl = $("tempItemQty");
	if (qEl) qEl.value = (editing && editing.qtyRemaining != null) ? String(editing.qtyRemaining) : "";
	renderTempStations(editing ? editing.stations : [...STATIONS]);
	$("tempItemHint").textContent = editing ? `Modifica articolo temporaneo (creato ${new Date(editing.createdAtMs).toLocaleString()})` : "Crea un articolo temporaneo valido su una o piu postazioni.";
	$("btnTempDelete").style.display = editing ? "inline-flex" : "none";
	$("tempItemModal").classList.add('show');
	$("tempItemModal").setAttribute('aria-hidden','false');
}

function closeTempItemModal() {
	$("tempItemModal").classList.remove('show');
	$("tempItemModal").setAttribute('aria-hidden','true');
	state.editingTempName = null;
}

function renderTempStations(selected) {
	const wrap = $("tempStations");
	wrap.innerHTML = "";
	const sel = new Set((selected || []).map(String));
	STATIONS.forEach(st => {
		const id = `ts_${keyName(st).replace(/[^a-z0-9]+/g,'_')}`;
		const lab = document.createElement('label');
		lab.className = 'chk';
		lab.innerHTML = `<input type="checkbox" id="${id}" ${sel.has(st) ? 'checked' : ''}><span>${st}</span>`;
		wrap.appendChild(lab);
	});
}

function getSelectedTempStations() {
	const wrap = $("tempStations");
	const out = [];
	wrap.querySelectorAll('input[type=checkbox]').forEach(ch => {
		if (ch.checked) {
			const name = ch.parentElement?.querySelector('span')?.textContent;
			if (name) out.push(String(name));
		}
	});
	return out;
}

function parseQtyInput(raw) {
	const s = String(raw ?? '').trim();
	if (!s) return null;
	const v = Math.floor(Number(s));
	if (Number.isNaN(v) || v < 0) return null;
	return v;
}

function parsePriceInput(raw) {
	const s = String(raw || '').trim().replace(',', '.');
	if (!s) return null;
	const v = Number(s);
	if (Number.isNaN(v) || v < 0) return null;
	return v;
}

function saveTempItem() {
	const name = normalizeName($("tempItemName").value);
	if (!name) { toast('Inserisci un nome articolo'); return; }
	const price = parsePriceInput($("tempItemPrice").value);
	if (price == null) { toast('Inserisci un prezzo valido'); return; }
	const qtyRemaining = parseQtyInput($("tempItemQty") ? $("tempItemQty").value : "");
	if ($("tempItemQty") && $("tempItemQty").value.trim() && qtyRemaining == null) { toast('Quantita non valida'); return; }
	const stations = getSelectedTempStations();
	if (!stations.length) { toast('Seleziona almeno una postazione'); return; }

	// Nome unico (case-insensitive): se esiste un base item con lo stesso nome, blocco
	const baseHit = MENU_ITEMS.find(x => keyName(x.name) === keyName(name));
	if (baseHit && (!state.editingTempName || keyName(state.editingTempName) !== keyName(name))) {
		toast('Esiste gia un articolo nel listino con questo nome');
		return;
	}

	let editing = state.editingTempName ? tempMenuItems.find(x => keyName(x.name) === keyName(state.editingTempName)) : null;
	if (editing) {
		// Se l'articolo e presente in almeno una comanda NON terminata, non consento di cambiare il nome.
		const inActiveOrder = orders.some(o => computeStatus(o) !== "done" && o.items.some(it => keyName(it.name) === keyName(editing.name)));
		if (inActiveOrder && keyName(editing.name) !== keyName(name)) { toast("Non puoi rinominare: articolo presente in una comanda non terminata"); return; }
		editing.name = name;
		editing.price = price;
		editing.stations = stations;
		editing.qtyRemaining = qtyRemaining;
		queueAction({ type:'temp_item_update', item: { id: editing.id, name, price, stations, qtyRemaining } });
		toast('Articolo temporaneo aggiornato');
	} else {
		const item = { id: safeUUID(), name, price, stations, createdAtMs: nowMs(), qtyRemaining };
		tempMenuItems.push(item);
		queueAction({ type:'temp_item_add', item });
		toast('Articolo temporaneo aggiunto');
	}
	saveTempItems(tempMenuItems);
	closeTempItemModal();
	renderCatalog();
	renderDetails();
}

function deleteTempItem() {
	const name = state.editingTempName;
	if (!name) return;
	const before = tempMenuItems.length;
	const hit = tempMenuItems.find(x => keyName(x.name) === keyName(name));
	if (!hit) { toast('Articolo temporaneo non trovato'); return; }
	const inActiveOrder = orders.some(o => computeStatus(o) !== "done" && o.items.some(it => keyName(it.name) === keyName(hit.name)));
	if (inActiveOrder) { toast("Non puoi rimuovere: articolo presente in una comanda non terminata"); return; }
	if (!confirm(`Rimuovere l'articolo temporaneo "${hit.name}"?`)) return;
	tempMenuItems = tempMenuItems.filter(x => x.id !== hit.id);
	saveTempItems(tempMenuItems);
	queueAction({ type:'temp_item_delete', itemId: hit.id, name: hit.name });
	toast('Articolo temporaneo rimosso');
	closeTempItemModal();
	renderCatalog();
	renderDetails();
}
// ------------------------------------------------------------
// Modali postazione / user (pre-esistenti)
// ------------------------------------------------------------
function initStationCSelect() {
	const c = $("stationCSelect");
	if (!c) return;
	const btn = c.querySelector(".cselect-btn");
	const menu = $("stationCSelectMenu");
	if (!btn || !menu) return;
	menu.innerHTML = "";
	STATIONS.forEach(st => {
		const opt = document.createElement('div');
		opt.className = 'cselect-opt';
		opt.textContent = st;
		opt.addEventListener('click', () => {
			$("stationSelect").value = st;
			updateStationCSelect();
			c.classList.remove('open');
		});
		menu.appendChild(opt);
	});
	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		c.classList.toggle('open');
	});
	document.addEventListener('click', (e) => {
		if (!c.contains(e.target)) c.classList.remove('open');
	});
	updateStationCSelect();
}

function updateStationCSelect() {
	const c = $("stationCSelect");
	const sel = $("stationSelect");
	const txt = $("stationCSelectText");
	if (!c || !sel || !txt) return;
	txt.textContent = sel.value || '-';
	c.querySelectorAll('.cselect-opt').forEach(o => {
		o.classList.toggle('active', o.textContent === sel.value);
	});
}

function openStationModal() {
	$("stationModal").classList.add("show");
	$("stationModal").setAttribute("aria-hidden", "false");
	$("stationSelect").value = state.stationName;
	updateStationCSelect(state.stationName);
}
function closeStationModal() {
	$("stationModal").classList.remove("show");
	$("stationModal").setAttribute("aria-hidden", "true");
}
function applyStation() {
	state.stationName = normalizeStationName($("stationSelect").value);
	if (typeof persistStationName === "function") {
		persistStationName();
	}
	toast(`Postazione: ${state.stationName}`);
	updateStationsSelf();
	closeStationModal();
	void syncMenuFromBackend();
	void syncOrdersFromBackend({ render: true });
	void syncStationNotificationsFromBackend();
	if (state.stationActive) {
		const msg = popNextNotificationForCurrentStation();
		if (msg) openNotifyModal(msg);
	}
	ensureAutoPrep();
	renderAll();
}

function handlePostazioneLoginSuccess(event) {
	const payload = event && event.detail && typeof event.detail === "object" ? event.detail : {};
	const name = String(payload.fullName || payload.username || "").trim();
	const role = String(payload.roleLabel || payload.role || "").trim() || "Operatore";
	if (!name) {
		toast("Dati login non validi");
		return;
	}

	state.loggedIn = true;
	state.userName = name;
	state.userRole = role;
	if (typeof persistOperatorSessionState === "function") {
		persistOperatorSessionState();
	}
	updateStationsSelf();
	toast(`Login: ${name}`);
	closeUserModal();
	renderTop();
	void syncWaitersFromBackend({ render: true });
}

function handlePostazioneLoginLogout() {
	doLogout();
}

function openUserModal() {
	const modal = $("userModal");
	if (!modal) return;
	modal.classList.add("show");
	modal.setAttribute("aria-hidden", "false");
	if (window.postazioneLoginUI && typeof window.postazioneLoginUI.open === "function") {
		window.postazioneLoginUI.open({
			loggedIn: state.loggedIn,
			userName: state.userName,
			userRole: state.userRole
		});
	}
}

function closeUserModal() {
	const modal = $("userModal");
	if (!modal) return;
	modal.classList.remove("show");
	modal.setAttribute("aria-hidden", "true");
	if (window.postazioneLoginUI && typeof window.postazioneLoginUI.close === "function") {
		window.postazioneLoginUI.close();
	}
}

function doLogin() {
	if (window.postazioneLoginUI && typeof window.postazioneLoginUI.requestSubmit === "function") {
		window.postazioneLoginUI.requestSubmit();
		return;
	}
	toast("Interfaccia login non pronta");
}

function doLogout() {
	state.loggedIn = false;
	state.userName = "Guest";
	state.userRole = "Non autenticato";
	if (typeof persistOperatorSessionState === "function") {
		persistOperatorSessionState();
	}
	updateStationsSelf();
	toast("Logout effettuato");
	closeUserModal();
	renderTop();
	void syncWaitersFromBackend({ render: true });
}

// ------------------------------------------------------------
// Event listeners
// ------------------------------------------------------------
$("stationToggle").addEventListener("change", function () {
	const wasActive = state.stationActive;
	state.stationActive = !!this.checked;
	updateStationsSelf();
	toast(state.stationActive ? "Postazione attiva" : "Postazione in pausa");

	// Se vado in PAUSA: trasferisco automaticamente TUTTE le comande non terminate
	// verso una postazione ONLINE (priorita = ordine STATIONS). Se non esistono
	// postazioni disponibili (tutte in pausa/chiuse), resto qui e mostro solo overlay.
	if (wasActive && !state.stationActive) {
		const from = state.stationName;
		const target = STATIONS
			.filter(n => n !== from)
			.map(n => getStationStateByName(n))
			.filter(st => st && st.active)
			.map(st => st.name)[0] || null;

		const toMove = orders
			.filter(o => o.station === from)
			.filter(o => computeStatus(o) !== "done");

		if (target && toMove.length) {
			toMove.forEach(o => {
				o.transferredFromStation = from;
				o.transferredToStation = target;
				o.transferredAtMs = nowMs();
				o.station = target;
				// Mantengo lo stato workflow (new/prep) ma aggiorno ownership verso la destinazione.
				o.ownerStation = target;
				const st = getStationStateByName(target);
				o.ownerOperator = st ? st.operatorName : null;
				o.ownerRole = st ? st.operatorRole : null;
				o.ownerAtMs = nowMs();
				void syncOrderToBackend(o);
			});
			queuePauseNotification(from, `Comande trasferite automaticamente a <strong>${target}</strong> perche la postazione e in pausa.`);
			// Se ero su una comanda che non appartiene piu a questa postazione, deseleziono.
			state.selectedOrderId = null;
			renderOrdersFull();
			updateSelectedCard();
		}
	}

	// Se esco dalla PAUSA: mostro eventuali notifiche valide (<60min)
	if (!wasActive && state.stationActive) {
		const msg = popNextNotificationForCurrentStation();
		if (msg) openNotifyModal(msg);
	}
	applyPauseUI();
	renderTop();
	renderDetails();
});

$("darkToggle").addEventListener("change", function () {
	state.darkMode = !!this.checked;
	toast(state.darkMode ? "Dark mode" : "Light mode");
	renderTop();
});

$("btnCall").addEventListener("click", function () {
	const o = getOrderById(state.selectedOrderId);
	if (!o) return;
	if (state.callMode === "recall") {
		requestRecallForSelected();
		return;
	}
	const roomLabel = buildOrderRoomLabel(o);
	const notification = buildWaiterNotificationContext(o, o.waiter);
	toast(`Chiamo cameriere: ${o.waiter}`);
	void publishIntegrationNotification(
		"waiter",
		notification.title,
		notification.description,
		{
			...notification.meta,
			orderId: o.id,
			table: o.table,
			tableNumber: o.tableNumber || o.table,
			tableId: o.tableId || "",
			roomId: o.roomId || "",
			roomName: roomLabel
		}
	);
});

$("btnPrint").addEventListener("click", function () {
	const o = getOrderById(state.selectedOrderId);
	if (!o) return;
	openPrintModal();
});

$("btnReady").addEventListener("click", async function () {
	const o = getOrderById(state.selectedOrderId);
	if (!o) return;
	if (!state.stationActive) { toast("Postazione in pausa"); return; }
	const currentStatus = computeStatus(o);
	if (currentStatus === "ready") { toast("Comanda gia' da ritirare"); return; }
	if (currentStatus === "done") { toast("Comanda gia' consegnata"); return; }

	o.items.forEach(i => {
		i.done = true;
		const temp = getTempItemByName(i.name);
		if (temp && temp.qtyRemaining != null && !i.stockDebited) {
			temp.qtyRemaining = Math.max(0, Number(temp.qtyRemaining) - 1);
			i.stockDebited = true;
		}
	});
	saveTempItems(tempMenuItems);
	o.workflowStatus = "ready";
	o.completedAtMs = null;
	toast(`Comanda #${o.id} da ritirare`);

	ensureAutoPrep();
	renderOrdersFull();
	updateSelectedCard();
	renderDetails();
	const synced = await syncOrderToBackend(o);
	if (!synced) {
		console.warn("[postazione] sync ordine PRONTA non riuscita", o.id);
	}
	const notified = await publishIntegrationNotification(
		"bell",
		"Comanda pronta",
		`Tavolo ${buildOrderTableLabel(o)}${buildOrderRoomLabel(o) ? ` (${buildOrderRoomLabel(o)})` : ""} - comanda #${o.id}`,
		{
			orderId: o.id,
			table: o.table,
			tableNumber: o.tableNumber || o.table,
			tableId: o.tableId || "",
			roomId: o.roomId || "",
			roomName: buildOrderRoomLabel(o),
			waiter: o.waiter,
			station: state.stationName
		}
	);
	if (!notified) {
		console.warn("[postazione] publish notifica comanda pronta non riuscita", o.id);
	}
	await syncOrdersFromBackend({ render: true });
});

$("btnTransfer").addEventListener("click", openTransferModal);
$("btnCatalog").addEventListener("click", openCatalogModal);

// Elementi presenti nei partials vengono inizializzati dopo loadPartials().
function initAfterPartials() {
  // click-backdrop close
  [
    ["stationModal", closeStationModal],
    ["userModal", closeUserModal],
    ["transferModal", closeTransferModal],
    ["catalogModal", closeCatalogModal],
    ["scopeModal", closeScopeModal],
    ["authModal", closeAuthModal],
    ["notifyModal", closeNotifyModal],
    ["tempItemModal", closeTempItemModal],
    ["printModal", closePrintModal]
  ].forEach(([id, fn]) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("click", (e) => { if (e.target.id === id) fn(); });
  });

  // Station select
  loadDisabledState();
  setOnlineUI(navigator.onLine);
  const sel = $("stationSelect");
  if (sel) {
    sel.innerHTML = "";
    STATIONS.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      sel.appendChild(opt);
    });
    initStationCSelect();
  }

  if (window.postazioneLoginUI && typeof window.postazioneLoginUI.ensureMounted === "function") {
    window.postazioneLoginUI.ensureMounted();
  }
  window.removeEventListener("postazione-login-success", handlePostazioneLoginSuccess);
  window.removeEventListener("postazione-login-logout", handlePostazioneLoginLogout);
  window.addEventListener("postazione-login-success", handlePostazioneLoginSuccess);
  window.addEventListener("postazione-login-logout", handlePostazioneLoginLogout);

  // Catalog: aggiungi temporaneo
  const addTemp = $("btnAddTempItem");
  if (addTemp) addTemp.addEventListener("click", () => openTempItemModal(null));

  // Catalog search
  const catSearch = $("catalogSearch");
  if (catSearch) {
    catSearch.addEventListener("input", function () {
      state.catalogQuery = this.value || "";
      renderCatalog();
    });
  }

  // Print modal buttons
  const b1 = $("btnPrintOrder");
  const b2 = $("btnPrintPreconto");
  if (b1) b1.addEventListener("click", () => { doPrintSelected("order"); closePrintModal(); });
  if (b2) b2.addEventListener("click", () => { doPrintSelected("preconto"); closePrintModal(); });
}

$("historyToggle").addEventListener("change", function () {
	state.showDone = !!this.checked;
	ensureSelection();
	renderTop();
	renderOrdersFull();
	updateSelectedCard();
	renderDetails();
});

$("orderSearch").addEventListener("input", function () {
	state.searchQuery = this.value;
	ensureSelection();
	renderOrdersFull();
	updateSelectedCard();
	renderDetails();
});

