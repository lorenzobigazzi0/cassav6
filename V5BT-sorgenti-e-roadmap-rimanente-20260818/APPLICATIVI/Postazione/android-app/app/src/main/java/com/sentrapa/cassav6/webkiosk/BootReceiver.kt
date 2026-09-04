package com.sentrapa.cassav6.webkiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == "android.intent.action.QUICKBOOT_POWERON"
        ) {
            AlwaysOnService.start(context)
            AlwaysOnService.refreshBluetooth(context)
        }
    }
}
