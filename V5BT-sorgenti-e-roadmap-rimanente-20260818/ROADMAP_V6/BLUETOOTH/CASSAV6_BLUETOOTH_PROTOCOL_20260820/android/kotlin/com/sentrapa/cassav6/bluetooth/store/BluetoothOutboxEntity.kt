package com.sentrapa.cassav6.bluetooth.store
data class BluetoothOutboxEntity(val messageId:String,val payload:ByteArray,val state:String,val createdAt:Long)
