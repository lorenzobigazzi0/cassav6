package com.cassav4.bluetooth
enum class BtState { DISABLED, PERMISSION_REQUIRED, STARTING, DISCOVERING, DIRECT_SERVER, PEER_CONNECTED, DEGRADED, BACKOFF, STOPPED }
class ConnectivityStateMachine(var state: BtState = BtState.DISABLED)
