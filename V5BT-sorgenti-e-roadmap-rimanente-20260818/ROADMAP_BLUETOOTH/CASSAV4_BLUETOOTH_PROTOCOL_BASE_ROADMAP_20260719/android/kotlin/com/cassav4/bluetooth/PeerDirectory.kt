package com.cassav4.bluetooth
data class PeerRecord(val alias:String,val rssi:Int,val lastSeenMs:Long,val capabilities:Int,val serverReachable:Boolean)
class PeerDirectory { private val peers=mutableMapOf<String,PeerRecord>() }
