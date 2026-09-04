package com.sentrapa.cassav6.bluetooth.store
data class SessionHistoryEntity(val sessionId:String,val peerId:String,val openedAt:Long,val closedAt:Long?)
