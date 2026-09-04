(function mobileRoomPreferenceBridge() {
  if (window.__mobileRoomPreferenceBridgeInitialized) return;
  window.__mobileRoomPreferenceBridgeInitialized = true;

  var originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!originalFetch) return;

  function normalize(value) {
    return String(value == null ? "" : value).trim();
  }

  function readStorage(key) {
    try {
      var localValue = window.localStorage.getItem(key);
      if (localValue !== null) return localValue;
    } catch (_error) {}
    try {
      return window.sessionStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_error) {}
    try {
      window.sessionStorage.setItem(key, value);
    } catch (_error) {}
  }

  function removeStorage(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {}
    try {
      window.sessionStorage.removeItem(key);
    } catch (_error) {}
  }

  function getUserId() {
    return normalize(readStorage("pos_user_id"));
  }

  function readPreferenceMap() {
    try {
      var parsed = JSON.parse(readStorage("pos_last_room_by_user") || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function writePreferenceMap(map) {
    var text = JSON.stringify(map || {});
    writeStorage("pos_last_room_by_user", text);
  }

  function rememberRoom(userId, room) {
    var safeUserId = normalize(userId || getUserId());
    var roomId = normalize(room && (room.roomId || room.id));
    var roomName = normalize(room && (room.roomName || room.name));
    if (!safeUserId || !roomId) return;
    var map = readPreferenceMap();
    map[safeUserId] = {
      roomId: roomId,
      roomName: roomName,
      updatedAt: new Date().toISOString(),
    };
    writePreferenceMap(map);
    writeStorage("pos_room_id", roomId);
    if (roomName) writeStorage("pos_room_name", roomName);
    try {
      window.dispatchEvent(new CustomEvent("mobile:room-preference-updated", {
        detail: { userId: safeUserId, roomId: roomId, roomName: roomName },
      }));
    } catch (_error) {}
  }

  function restoreStoredRoomForCurrentUser() {
    var userId = getUserId();
    if (!userId) return;
    var preferred = readPreferenceMap()[userId];
    if (!preferred || !preferred.roomId) return;
    writeStorage("pos_room_id", normalize(preferred.roomId));
    if (preferred.roomName) writeStorage("pos_room_name", normalize(preferred.roomName));
  }

  function reorderRooms(payload, preferredRoomId) {
    if (!payload || !Array.isArray(payload.rooms)) return payload;
    var rooms = payload.rooms.slice();
    var directRooms = rooms.filter(function (room) {
      return room && room.enabled !== false && room.authorized === true && room.requiresAdminAuth !== true;
    });
    var otherRooms = rooms.filter(function (room) {
      return directRooms.indexOf(room) < 0;
    });
    rooms = directRooms.concat(otherRooms);
    if (!preferredRoomId) return Object.assign({}, payload, { rooms: rooms });
    var index = rooms.findIndex(function (room) {
      return normalize(room && (room.roomId || room.id)) === preferredRoomId;
    });
    if (index < 0) return Object.assign({}, payload, { rooms: rooms });
    if (index === 0) return Object.assign({}, payload, { rooms: rooms });
    var preferred = rooms.splice(index, 1)[0];
    if (!(preferred && preferred.enabled !== false && preferred.authorized === true && preferred.requiresAdminAuth !== true)) {
      return Object.assign({}, payload, { rooms: rooms.concat([preferred]) });
    }
    return Object.assign({}, payload, { rooms: [preferred].concat(rooms) });
  }

  function isDirectRoom(room) {
    return Boolean(
      room &&
        room.enabled !== false &&
        room.authorized === true &&
        room.requiresAdminAuth !== true
    );
  }

  function findRoomById(rooms, roomId) {
    var safeRoomId = normalize(roomId);
    if (!safeRoomId || !Array.isArray(rooms)) return null;
    return rooms.find(function (room) {
      return normalize(room && (room.roomId || room.id)) === safeRoomId;
    }) || null;
  }

  function applyPayloadPreference(pathname, payload) {
    if (!payload || typeof payload !== "object") return payload;
    var userId = normalize((payload.user && payload.user.id) || payload.userId || getUserId());
    if (pathname === "/api/auth/login" && payload.ok && payload.user) {
      var directInitialRoom =
        payload.initialRoom &&
        payload.initialRoom.authorized === true &&
        payload.initialRoom.requiresAdminAuth !== true
          ? payload.initialRoom
          : null;
      var loginRoom = directInitialRoom
        ? {
            roomId: directInitialRoom.roomId || directInitialRoom.id,
            roomName: directInitialRoom.roomName || directInitialRoom.name || "",
          }
        : null;
      if (loginRoom) rememberRoom(payload.user.id, loginRoom);
      else {
        removeStorage("pos_room_id");
        removeStorage("pos_room_name");
      }
      return payload;
    }
    if (pathname === "/api/pos/rooms") {
      var initialRoom = payload.initialRoom || null;
      var currentRoomId = normalize(readStorage("pos_room_id"));
      var currentRoom = findRoomById(payload.rooms, currentRoomId);
      var keepCurrentRoom = isDirectRoom(currentRoom);
      if (!keepCurrentRoom && initialRoom && initialRoom.roomId) rememberRoom(userId, initialRoom);
      var preferredRoomId = keepCurrentRoom
        ? currentRoomId
        : normalize((initialRoom && initialRoom.roomId) || payload.lastSelectedRoomId);
      return reorderRooms(payload, preferredRoomId);
    }
    if ((pathname === "/api/pos/room-change/request" || pathname === "/api/pos/room-change/approve") && payload.ok && payload.room) {
      rememberRoom(userId, payload.room);
    }
    return payload;
  }

  function responseUrlPath(response, input) {
    try {
      return new URL(response && response.url ? response.url : String(input), window.location.origin).pathname;
    } catch (_error) {
      return "";
    }
  }

  window.fetch = function patchedFetch(input, init) {
    return originalFetch(input, init).then(function (response) {
      var pathname = responseUrlPath(response, input);
      if (
        pathname !== "/api/auth/login" &&
        pathname !== "/api/pos/rooms" &&
        pathname !== "/api/pos/room-change/request" &&
        pathname !== "/api/pos/room-change/approve"
      ) {
        return response;
      }
      return response.clone().json().then(function (payload) {
        var nextPayload = applyPayloadPreference(pathname, payload);
        if (nextPayload === payload) return response;
        var headers = new Headers(response.headers);
        headers.set("Content-Type", "application/json");
        return new Response(JSON.stringify(nextPayload), {
          status: response.status,
          statusText: response.statusText,
          headers: headers,
        });
      }).catch(function () {
        return response;
      });
    });
  };

  restoreStoredRoomForCurrentUser();
})();
