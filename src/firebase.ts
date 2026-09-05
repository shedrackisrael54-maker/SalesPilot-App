import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: 'AIzaSyDw4X0KRGxIfWgfamIAgxSmkbktSzPSCg4',
  // Using our own subdomain instead of the default *.firebaseapp.com address. The default
  // domain has been intermittently unreachable (ERR_CONNECTION_REFUSED) for Google sign-in
  // and password reset links, and routing through our own domain also looks more trustworthy
  // to anyone who notices the URL during sign-in.
  authDomain: 'auth.salespilot.com.ng',
  projectId: 'salespilot-200e5',
  storageBucket: 'salespilot-200e5.firebasestorage.app',
  messagingSenderId: '474948499696',
  appId: '1:474948499696:web:3953d25d77acccc5f82a35',
  measurementId: 'G-GBMFVR5WMC',
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
