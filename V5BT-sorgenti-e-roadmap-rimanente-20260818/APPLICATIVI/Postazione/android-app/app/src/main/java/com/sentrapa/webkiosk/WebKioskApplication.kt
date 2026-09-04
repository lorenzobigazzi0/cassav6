package com.sentrapa.webkiosk

import android.app.Application
import com.sentrapa.webkiosk.notifications.NotificationHelper

class WebKioskApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        NotificationHelper.ensureChannels(this)
    }
}
