#!/usr/bin/env python3
"""Register one transient Cassa V6 Bluetooth advertisement through BlueZ D-Bus."""

from __future__ import annotations

import argparse
import re
import signal
import sys
from dataclasses import dataclass
from typing import Any
from uuid import UUID


BLUEZ_SERVICE = "org.bluez"
DBUS_OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager"
DBUS_PROPERTIES = "org.freedesktop.DBus.Properties"
LE_ADVERTISEMENT = "org.bluez.LEAdvertisement1"
LE_ADVERTISING_MANAGER = "org.bluez.LEAdvertisingManager1"

DEFAULT_ADAPTER_PATH = "/org/bluez/hci0"
ADVERTISEMENT_PATH = "/com/cassav6/bluetooth/lab/advertisement_v1"
SERVICE_UUID = "3c9734f1-46cb-5672-96e9-e7a03a710f95"
PROTOCOL_VERSION = 1
LEGACY_FLAGS = 0x06
MAX_LEGACY_ADVERTISEMENT_BYTES = 31
PAYLOAD_BYTES = 10

NODE_KIND_CODES = {
    "raspberry": 1,
    "handheld": 2,
    "station": 3,
}

FROZEN_VECTOR = {
    "protocol_version": 1,
    "node_kind": "handheld",
    "rotating_alias": "aabbccddeeff",
    "boot_id": 17,
    "capabilities": 47,
    "server_reachable": True,
    "sequence": 102,
}
FROZEN_PAYLOAD_HEX = "31aabbccddeeff112f66"
FROZEN_LEGACY_ADVERTISEMENT_HEX = (
    "0201061b21950f713aa0e7e9967256cb46f134973c"
    "31aabbccddeeff112f66"
)


@dataclass(frozen=True)
class AdvertisementFields:
    protocol_version: int
    node_kind: str
    rotating_alias: str
    boot_id: int
    capabilities: int
    server_reachable: bool
    sequence: int


def _integer_in_range(value: int, minimum: int, maximum: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer")
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def validate_fields(fields: AdvertisementFields) -> AdvertisementFields:
    if fields.protocol_version != PROTOCOL_VERSION:
        raise ValueError(f"protocol_version must be {PROTOCOL_VERSION}")
    if fields.node_kind not in NODE_KIND_CODES:
        raise ValueError("node_kind must be raspberry, handheld, or station")
    if re.fullmatch(r"[0-9a-fA-F]{12}", fields.rotating_alias) is None:
        raise ValueError("rotating_alias must contain exactly 12 hex characters")
    _integer_in_range(fields.boot_id, 1, 255, "boot_id")
    _integer_in_range(fields.capabilities, 0, 0x7F, "capabilities")
    if not isinstance(fields.server_reachable, bool):
        raise ValueError("server_reachable must be a boolean")
    _integer_in_range(fields.sequence, 0, 255, "sequence")
    return fields


def encode_payload(fields: AdvertisementFields) -> bytes:
    validated = validate_fields(fields)
    header = (
        validated.protocol_version
        | (NODE_KIND_CODES[validated.node_kind] << 3)
        | (0x20 if validated.server_reachable else 0)
    )
    payload = bytes(
        [header]
        + list(bytes.fromhex(validated.rotating_alias))
        + [validated.boot_id, validated.capabilities, validated.sequence]
    )
    if len(payload) != PAYLOAD_BYTES:
        raise AssertionError("internal error: advertisement payload is not 10 bytes")
    return payload


def uuid128_little_endian(uuid_text: str) -> bytes:
    return UUID(uuid_text).bytes[::-1]


def encode_expected_legacy_advertisement(fields: AdvertisementFields) -> bytes:
    payload = encode_payload(fields)
    service_data = uuid128_little_endian(SERVICE_UUID) + payload
    advertisement = bytes(
        [0x02, 0x01, LEGACY_FLAGS, 1 + len(service_data), 0x21]
    ) + service_data
    if len(advertisement) != MAX_LEGACY_ADVERTISEMENT_BYTES:
        raise AssertionError("internal error: legacy advertisement is not 31 bytes")
    return advertisement


def run_self_test() -> None:
    fields = AdvertisementFields(**FROZEN_VECTOR)
    payload = encode_payload(fields)
    advertisement = encode_expected_legacy_advertisement(fields)
    if payload.hex() != FROZEN_PAYLOAD_HEX:
        raise AssertionError(
            f"payload mismatch: expected {FROZEN_PAYLOAD_HEX}, got {payload.hex()}"
        )
    if advertisement.hex() != FROZEN_LEGACY_ADVERTISEMENT_HEX:
        raise AssertionError(
            "legacy advertisement mismatch: "
            f"expected {FROZEN_LEGACY_ADVERTISEMENT_HEX}, got {advertisement.hex()}"
        )
    print("SELF_TEST=PASS")
    print(f"PAYLOAD_BYTES={len(payload)}")
    print(f"LEGACY_ADVDATA_BYTES={len(advertisement)}")
    print(f"LEGACY_ADVDATA_HEX={advertisement.hex()}")


def _load_dbus() -> tuple[Any, Any, Any]:
    try:
        import dbus
        import dbus.mainloop.glib
        import dbus.service
        from gi.repository import GLib
    except ImportError as error:
        raise RuntimeError(
            "runtime registration requires python3-dbus and PyGObject"
        ) from error
    return dbus, dbus.mainloop.glib, GLib


def register_transient_advertisement(
    *,
    fields: AdvertisementFields,
    adapter_path: str,
    duration_seconds: int,
) -> int:
    dbus, dbus_mainloop, glib = _load_dbus()
    dbus_mainloop.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()

    object_manager = dbus.Interface(
        bus.get_object(BLUEZ_SERVICE, "/"),
        DBUS_OBJECT_MANAGER,
    )
    managed_objects = object_manager.GetManagedObjects()
    if (
        adapter_path not in managed_objects
        or LE_ADVERTISING_MANAGER not in managed_objects[adapter_path]
    ):
        raise RuntimeError(
            f"{adapter_path} does not expose {LE_ADVERTISING_MANAGER}"
        )

    payload = encode_payload(fields)
    expected = encode_expected_legacy_advertisement(fields)

    class Advertisement(dbus.service.Object):
        def __init__(self) -> None:
            self.path = dbus.ObjectPath(ADVERTISEMENT_PATH)
            super().__init__(bus, self.path)
            self.released = False

        def properties(self) -> dict[str, dict[str, Any]]:
            return {
                LE_ADVERTISEMENT: {
                    "Type": dbus.String("peripheral"),
                    "ServiceData": dbus.Dictionary(
                        {
                            SERVICE_UUID: dbus.Array(
                                [dbus.Byte(byte) for byte in payload],
                                signature="y",
                            )
                        },
                        signature="sv",
                    ),
                    "Discoverable": dbus.Boolean(True),
                    "DiscoverableTimeout": dbus.UInt16(0),
                }
            }

        @dbus.service.method(
            DBUS_PROPERTIES,
            in_signature="ss",
            out_signature="v",
        )
        def Get(self, interface_name: str, property_name: str) -> Any:
            properties = self.properties()
            if interface_name not in properties:
                raise dbus.exceptions.DBusException(
                    "org.freedesktop.DBus.Error.InvalidArgs",
                    f"unknown interface {interface_name}",
                )
            if property_name not in properties[interface_name]:
                raise dbus.exceptions.DBusException(
                    "org.freedesktop.DBus.Error.InvalidArgs",
                    f"unknown property {property_name}",
                )
            return properties[interface_name][property_name]

        @dbus.service.method(
            DBUS_PROPERTIES,
            in_signature="s",
            out_signature="a{sv}",
        )
        def GetAll(self, interface_name: str) -> dict[str, Any]:
            properties = self.properties()
            if interface_name not in properties:
                raise dbus.exceptions.DBusException(
                    "org.freedesktop.DBus.Error.InvalidArgs",
                    f"unknown interface {interface_name}",
                )
            return properties[interface_name]

        @dbus.service.method(
            LE_ADVERTISEMENT,
            in_signature="",
            out_signature="",
        )
        def Release(self) -> None:
            self.released = True
            print("BLUEZ_RELEASED=1", flush=True)

    advertisement = Advertisement()
    manager = dbus.Interface(
        bus.get_object(BLUEZ_SERVICE, adapter_path),
        LE_ADVERTISING_MANAGER,
    )
    loop = glib.MainLoop()
    state: dict[str, Any] = {
        "registered": False,
        "registration_error": None,
        "cleanup_error": None,
        "stop_requested": False,
    }

    def request_stop(*_unused: Any) -> bool:
        state["stop_requested"] = True
        loop.quit()
        return False

    def registration_ok() -> None:
        state["registered"] = True
        print("REGISTERED=1", flush=True)
        glib.timeout_add_seconds(duration_seconds, request_stop)

    def registration_failed(error: Exception) -> None:
        state["registration_error"] = str(error)
        print(f"REGISTER_ERROR={error}", file=sys.stderr, flush=True)
        loop.quit()

    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_args: glib.idle_add(request_stop))

    print(f"SERVICE_UUID={SERVICE_UUID}")
    print(f"PAYLOAD_BYTES={len(payload)}")
    print(f"PAYLOAD_HEX={payload.hex()}")
    print(f"EXPECTED_LEGACY_ADVDATA_BYTES={len(expected)}")
    print(f"EXPECTED_LEGACY_ADVDATA_HEX={expected.hex()}")
    print("BLUEZ_PROPERTIES=Type(peripheral),ServiceData,Discoverable")
    print("SCAN_RESPONSE_PROPERTIES=none")
    print(f"DURATION_SECONDS={duration_seconds}", flush=True)

    manager.RegisterAdvertisement(
        advertisement.path,
        dbus.Dictionary({}, signature="sv"),
        reply_handler=registration_ok,
        error_handler=registration_failed,
    )

    try:
        loop.run()
    finally:
        if state["registered"] and not advertisement.released:
            try:
                manager.UnregisterAdvertisement(advertisement.path)
                state["registered"] = False
                print("UNREGISTERED=1", flush=True)
            except Exception as error:  # pragma: no cover - requires live D-Bus failure
                state["cleanup_error"] = str(error)
                print(f"UNREGISTER_ERROR={error}", file=sys.stderr, flush=True)
        advertisement.remove_from_connection()

    if state["registration_error"]:
        return 2
    if state["cleanup_error"]:
        return 3
    if not state["stop_requested"]:
        return 4
    return 0


def _parse_integer(value: str) -> int:
    try:
        return int(value, 0)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"invalid integer: {value}") from error


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Register a transient V6 v1 BlueZ advertisement. "
            "BlueZ supplies the 02 01 06 Flags structure; this process supplies "
            "only the 128-bit Service Data UUID and 10-byte payload."
        )
    )
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--adapter", default=DEFAULT_ADAPTER_PATH)
    parser.add_argument(
        "--duration",
        type=int,
        default=10,
        help="registration lifetime in seconds (1..300)",
    )
    parser.add_argument(
        "--node-kind",
        choices=sorted(NODE_KIND_CODES),
        default="raspberry",
    )
    alias_source = parser.add_mutually_exclusive_group()
    alias_source.add_argument("--alias", default="aabbccddeeff")
    alias_source.add_argument("--alias-stdin", action="store_true")
    parser.add_argument("--boot-id", type=_parse_integer, default=17)
    parser.add_argument("--capabilities", type=_parse_integer, default=0x7F)
    parser.add_argument("--sequence", type=_parse_integer, default=102)
    reachability = parser.add_mutually_exclusive_group()
    reachability.add_argument(
        "--server-reachable",
        dest="server_reachable",
        action="store_true",
    )
    reachability.add_argument(
        "--server-unreachable",
        dest="server_reachable",
        action="store_false",
    )
    parser.set_defaults(server_reachable=True)
    args = parser.parse_args(argv)
    if args.duration < 1 or args.duration > 300:
        parser.error("--duration must be between 1 and 300 seconds")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        if args.self_test:
            run_self_test()
            return 0
        rotating_alias = (
            sys.stdin.readline().strip()
            if args.alias_stdin
            else args.alias
        )
        if args.alias_stdin and not rotating_alias:
            raise ValueError("alias stdin is empty")
        fields = AdvertisementFields(
            protocol_version=PROTOCOL_VERSION,
            node_kind=args.node_kind,
            rotating_alias=rotating_alias.lower(),
            boot_id=args.boot_id,
            capabilities=args.capabilities,
            server_reachable=args.server_reachable,
            sequence=args.sequence,
        )
        return register_transient_advertisement(
            fields=fields,
            adapter_path=args.adapter,
            duration_seconds=args.duration,
        )
    except (RuntimeError, ValueError) as error:
        print(f"ERROR={error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
