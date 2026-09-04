CREATE TABLE IF NOT EXISTS reservation_state_versions (
  room_id TEXT NOT NULL,
  service_date TEXT NOT NULL,
  state_key TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  PRIMARY KEY (room_id, service_date)
);

INSERT INTO reservation_state_versions (
  room_id,
  service_date,
  state_key,
  version
)
SELECT
  room_id,
  service_date,
  MAX(state_key),
  MAX(CASE WHEN revision > 0 THEN revision ELSE 1 END)
FROM reservations
GROUP BY room_id, service_date
ON CONFLICT(room_id, service_date) DO UPDATE SET
  state_key = excluded.state_key,
  version = MAX(reservation_state_versions.version, excluded.version);
