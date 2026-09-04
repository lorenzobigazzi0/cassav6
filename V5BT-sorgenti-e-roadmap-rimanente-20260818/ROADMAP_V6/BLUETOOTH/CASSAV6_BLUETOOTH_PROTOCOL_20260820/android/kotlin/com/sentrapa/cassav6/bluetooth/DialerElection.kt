package com.sentrapa.cassav6.bluetooth
object DialerElection { fun localRole(localAlias:String,remoteAlias:String)=if(localAlias.lowercase()<remoteAlias.lowercase()) "GATT_SERVER" else "GATT_CLIENT" }
