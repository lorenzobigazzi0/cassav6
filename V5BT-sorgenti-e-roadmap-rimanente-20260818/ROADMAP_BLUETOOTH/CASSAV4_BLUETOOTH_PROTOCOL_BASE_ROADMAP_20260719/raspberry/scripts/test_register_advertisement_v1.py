#!/usr/bin/env python3
"""Pure unit tests for register_advertisement_v1.py."""

from __future__ import annotations

import importlib.util
import io
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("register_advertisement_v1.py")
SPEC = importlib.util.spec_from_file_location("register_advertisement_v1", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {SCRIPT_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class AdvertisementV1Test(unittest.TestCase):
    def test_frozen_payload(self) -> None:
        fields = MODULE.AdvertisementFields(**MODULE.FROZEN_VECTOR)
        self.assertEqual(
            MODULE.encode_payload(fields).hex(),
            MODULE.FROZEN_PAYLOAD_HEX,
        )

    def test_frozen_legacy_advertisement(self) -> None:
        fields = MODULE.AdvertisementFields(**MODULE.FROZEN_VECTOR)
        encoded = MODULE.encode_expected_legacy_advertisement(fields)
        self.assertEqual(len(encoded), 31)
        self.assertEqual(encoded.hex(), MODULE.FROZEN_LEGACY_ADVERTISEMENT_HEX)
        self.assertEqual(encoded[:3].hex(), "020106")
        self.assertEqual(encoded[3:5].hex(), "1b21")
        self.assertEqual(
            encoded[5:21].hex(),
            "0100416c4b4f649a324f1f7d00a5c4b1",
        )

    def test_raspberry_fields_use_the_same_budget(self) -> None:
        fields = MODULE.AdvertisementFields(
            protocol_version=1,
            node_kind="raspberry",
            rotating_alias="001122334455",
            boot_id=1,
            capabilities=0x7F,
            server_reachable=True,
            sequence=255,
        )
        self.assertEqual(MODULE.encode_payload(fields).hex(), "29001122334455017fff")
        self.assertEqual(len(MODULE.encode_expected_legacy_advertisement(fields)), 31)

    def test_reserved_capability_bit_is_rejected(self) -> None:
        fields = MODULE.AdvertisementFields(
            protocol_version=1,
            node_kind="raspberry",
            rotating_alias="001122334455",
            boot_id=1,
            capabilities=0x80,
            server_reachable=True,
            sequence=1,
        )
        with self.assertRaisesRegex(ValueError, "capabilities"):
            MODULE.encode_payload(fields)

    def test_invalid_alias_is_rejected(self) -> None:
        fields = MODULE.AdvertisementFields(
            protocol_version=1,
            node_kind="raspberry",
            rotating_alias="not-an-alias",
            boot_id=1,
            capabilities=0,
            server_reachable=False,
            sequence=1,
        )
        with self.assertRaisesRegex(ValueError, "rotating_alias"):
            MODULE.encode_payload(fields)

    def test_alias_with_whitespace_is_rejected(self) -> None:
        fields = MODULE.AdvertisementFields(
            protocol_version=1,
            node_kind="raspberry",
            rotating_alias="aa bb cc dd ",
            boot_id=1,
            capabilities=0,
            server_reachable=False,
            sequence=1,
        )
        with self.assertRaisesRegex(ValueError, "rotating_alias"):
            MODULE.encode_payload(fields)

    def test_alias_can_be_supplied_without_process_arguments(self) -> None:
        args = MODULE.parse_args(["--alias-stdin"])
        self.assertTrue(args.alias_stdin)
        self.assertEqual(args.alias, "aabbccddeeff")

        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            MODULE.parse_args(["--alias", "001122334455", "--alias-stdin"])


if __name__ == "__main__":
    unittest.main()
