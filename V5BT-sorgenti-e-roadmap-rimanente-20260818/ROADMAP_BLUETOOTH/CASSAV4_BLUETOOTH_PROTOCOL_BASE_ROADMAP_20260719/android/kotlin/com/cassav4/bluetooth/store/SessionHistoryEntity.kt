package com.cassav4.bluetooth.store
data class SessionHistoryEntity(val sessionId:String,val peerId:String,val openedAt:Long,val closedAt:Long?)
