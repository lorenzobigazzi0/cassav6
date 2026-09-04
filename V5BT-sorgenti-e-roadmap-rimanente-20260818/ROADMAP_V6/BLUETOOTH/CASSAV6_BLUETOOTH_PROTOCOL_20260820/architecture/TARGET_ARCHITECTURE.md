# Target architecture base

```text
WebView/GUI
   │ native bridge
BluetoothFailoverService Android
   ├─ scanner/advertiser
   ├─ GATT client/server
   ├─ peer directory
   ├─ local outbox/inbox
   └─ UI state

Raspberry
   └─ cassav6-bluetooth-node
      ├─ BlueZ scanner
      ├─ LE advertiser
      ├─ GATT server
      ├─ device registry
      └─ backend health probe
```
