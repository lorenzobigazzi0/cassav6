#!/usr/bin/env bash
set -euo pipefail
bluetoothctl show
busctl tree org.bluez
