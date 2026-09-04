// expose functions to HTML onclick
window.openStationModal = openStationModal;
window.closeStationModal = closeStationModal;
window.applyStation = applyStation;
window.openUserModal = openUserModal;
window.closeUserModal = closeUserModal;
window.doLogin = doLogin;
window.doLogout = doLogout;
window.closeTransferModal = closeTransferModal;
window.applyTransfer = applyTransfer;
window.closeCatalogModal = closeCatalogModal;
window.closeScopeModal = closeScopeModal;
window.disableItemScope = disableItemScope;
window.closeAuthModal = closeAuthModal;
window.approveAuth = approveAuth;
window.denyAuth = denyAuth;
window.closeNotifyModal = closeNotifyModal;
window.ackNotify = ackNotify;
window.initAfterPartials = initAfterPartials;
window.openPrintModal = openPrintModal;
window.closePrintModal = closePrintModal;


async function loadPartials() {
	const root = document.getElementById('partialsRoot');
	if (!root) return;
	try {
		const res = await fetch('partials/ui.html', { cache: 'no-store' });
		if (!res.ok) throw new Error('HTTP ' + res.status);
		root.innerHTML = await res.text();
	} catch (e) {
		console.warn('Impossibile caricare partials/ui.html. Se stai aprendo il file via file://, serve un server HTTP locale.', e);
	}
}

function checkIncomingAuthRequests() {
	// Se ho gia' una richiesta aperta, non sovrascrivo.
	if (state.pendingAuth) return;

	// Mostro la richiesta SOLO alla postazione proprietaria (owner) quando e' online.
	const incoming = orders.find(o =>
		o &&
		o.pendingAuthRequest &&
		o.pendingAuthRequest.mode === "takeover" &&
		o.pendingAuthRequest.fromStation === state.stationName &&
		(o.ownerStation === state.stationName) &&
		(o.pendingAuthRequest.shownToOwner === false)
	);

	if (!incoming) return;
	incoming.pendingAuthRequest.shownToOwner = true;
	state.pendingAuth = incoming.pendingAuthRequest;
	openAuthModal();
}

function renderAll() {
	updateStationsSelf();
	checkIncomingAuthRequests();
	ensureAutoPrep();
	ensureSelection();
	renderTop();
	renderOrdersFull();
	renderDetails();
	renderWaiters();
	applyPauseUI();
}

// init selection prefer non done
(function initSelection() {
	ensureAutoPrep();
	const visible = sortOrders(getVisibleOrdersForStation());
	const first = visible.find(o => computeStatus(o) !== "done") || visible[0];
	state.selectedOrderId = first ? first.id : null;
})();

(async function bootstrap() {
	await loadPartials();
	initAfterPartials();
	await apiRefreshFlags();
	await syncMenuFromBackend();
	await syncOrdersFromBackend({ render: false });
	await syncWaitersFromBackend({ render: false });
	await syncStationNotificationsFromBackend();
	renderAll();
	renderClock();

	setInterval(() => {
		renderClock();
		updateOrdersTimersAndStatus();
		renderDetails();
	}, 1000);

	setInterval(async () => {
		await syncMenuFromBackend();
		await syncOrdersFromBackend({ render: true });
		await syncWaitersFromBackend();
		await syncStationNotificationsFromBackend();
	}, 2000);
})();

// ------------------------------------------------------------
// ANTI-ZOOM & KIOSK MODE FIX (iOS Safari)
// ------------------------------------------------------------
document.addEventListener('gesturestart', function (e) {
	// Blocca il pinch-to-zoom
	e.preventDefault();
});

document.addEventListener('dblclick', function (e) {
	// Blocca il doppio tap per zoomare (quando supportato)
	e.preventDefault();
}, { passive: false });

// Impedisci lo scroll "elastico" dell'intera pagina (rubber banding)
// In PAUSA blocco QUALSIASI scroll/touchmove.
document.body.addEventListener('touchmove', function (e) {
	if (state && state.stationActive === false) {
		e.preventDefault();
		return;
	}
	// Blocca touchmove solo se NON siamo dentro un elemento scrollabile.
	// Nota: sui tablet touch Android, un micro-movimento del dito durante un "tap"
	// può generare un touchmove; se lo preveniamo qui, il click sul bottone può
	// non essere emesso (es. btnTempSave nei modali). Per questo includiamo i modali
	// tra i contenitori "safe".
	if (!e.target.closest(
		'.is-scroll, .sidebar, .orders-list, .item-list, .waiter-buttons, .cselect-menu, ' +
		'.modal-backdrop, .modal-card, .modal-body, .modal-actions'
	)) {
		e.preventDefault();
	}
}, { passive: false });

// ------------------------------------------------------------
// KIOSK PAUSE LOCK (disabilita tutto tranne Play/Pausa)
// ------------------------------------------------------------
function __pauseAllowedTarget(el) {
	return !!(el && el.closest && el.closest('.station-status-wrapper'));
}

function __blockIfPaused(e) {
	if (!state || state.stationActive !== false) return;
	if (__pauseAllowedTarget(e.target)) return;
	e.preventDefault();
	// stopImmediatePropagation per neutralizzare listener registrati altrove
	if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
	else if (typeof e.stopPropagation === 'function') e.stopPropagation();
}

// Cattura in fase capturing per essere "prima" di tutti gli altri handler
['pointerdown','mousedown','touchstart','click'].forEach(evt => {
	document.addEventListener(evt, __blockIfPaused, true);
});

// Blocca tastiera quando in pausa (evita attivazione input, scorciatoie, ecc.)
document.addEventListener('keydown', function(e){
	if (!state || state.stationActive !== false) return;
	// Consenti solo interazione se il focus è sul toggle Play/Pausa
	const a = document.activeElement;
	if (__pauseAllowedTarget(a)) return;
	e.preventDefault();
	if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
	else if (typeof e.stopPropagation === 'function') e.stopPropagation();
}, true);
