package com.sentrapa.cassav6.webkiosk

import android.app.Application
import com.sentrapa.cassav6.webkiosk.notifications.NotificationHelper

class WebKioskApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        NotificationHelper.ensureChannels(this)
    }
}
