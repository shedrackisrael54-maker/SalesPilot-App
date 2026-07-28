// This file goes into the FRONTEND repo (SalesPilot-App), at this exact path:
// public/firebase-messaging-sw.js
//
// This is what lets a phone show a real notification - in the actual notification tray -
// even when the app itself is closed. It has to be a plain, separate file like this (not part
// of App.tsx) because service workers run completely outside the normal app, in the background.

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyDw4X0KRGxIfWgfamIAgxSmkbktSzPSCg4',
  authDomain: 'salespilot-200e5.firebaseapp.com',
  projectId: 'salespilot-200e5',
  storageBucket: 'salespilot-200e5.firebasestorage.app',
  messagingSenderId: '474948499696',
  appId: '1:474948499696:web:3953d25d77acccc5f82a35',
});

const messaging = firebase.messaging();

// Fires when a notification arrives while the app is closed or in the background - this is
// what actually puts it into the phone's real notification tray.
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || 'SalesPilot';
  const options = {
    body: payload.notification?.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
  };
  self.registration.showNotification(title, options);
});
