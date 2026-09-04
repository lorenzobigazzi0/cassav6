package com.cassav4.bluetooth
data class BtCapabilities(val scan:Boolean,val advertise:Boolean,val gattClient:Boolean,val gattServer:Boolean,val maxMtu:Int)
class BluetoothCapabilityProbe { fun classify(c:BtCapabilities)=if(c.scan&&c.advertise&&c.gattClient&&c.gattServer) "FULL_NODE" else if(c.scan&&c.gattClient) "CLIENT_ONLY" else "UNSUPPORTED" }
