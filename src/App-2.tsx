import { useState, useEffect, useRef, createContext, useContext, Component } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams, useNavigate } from 'react-router-dom';
import { StorefrontScreen, ProductDetailScreen, CheckoutScreen, TrackOrderScreen, OrderLinkScreen } from './Storefront';
import { Home, ShoppingBag, Package, Users, MoreHorizontal, Bell, Menu, TrendingUp, ChevronRight, Search, Plus, ArrowLeft, Trash2, Camera, Tag, Copy, Wallet, AlertTriangle, Share2, Shirt, Watch, Gem, Footprints, ShoppingBasket, Sofa, Smartphone, Sparkles, Rocket, Image as ImageIcon, Landmark, MapPin, Phone, FileText, Store, Bot, CreditCard, BarChart3, Settings, HelpCircle, CheckCircle2, AlertCircle, Clock, Gift, ChevronDown, ArrowRight, X, ExternalLink, Megaphone, Star, MessageCircle, Truck, Mail, Info, BookOpen, HeartHandshake, Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';
import { auth, db, storage } from './firebase';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  OAuthProvider,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { doc, setDoc, getDoc, onSnapshot, collection, deleteDoc, addDoc, query, orderBy, limit as fsLimit, arrayUnion, increment, getDocs } from 'firebase/firestore';

import { NAIRA, THEME_NICHES, PRODUCT_CATEGORIES, PRODUCT_ICON_MAP, PRODUCT_ICON_KEYS, ProductIcon, compressImage, uploadToCloudinary, isValidCSSColor, isColorOptionGroup, NIGERIAN_STATES, PAYSTACK_PUBLIC_KEY, PLATFORM_LOGO_URL, getOptimizedImageUrl, SUPPORT_EMAIL, FCM_VAPID_KEY, copyToClipboard, LANDING_IMAGES } from './shared';
import type { StoreTheme, ThemeNiche, DescriptionSection, OptionGroup, Product, Review, Order, Bundle, Courier, CheckoutField } from './shared';

const AuthContext = createContext<any>(null);
const useAuth = () => useContext(AuthContext);

// Stage 2 of staff permissions: what each role can actually see and do. Admin (the default
// for the merchant themselves) always has full access - only staff logged in as Sales or
// Inventory get restricted. "null" for a role's tabs/actions is treated as "no restriction".
const ROLE_TABS: { [role: string]: string[] } = {
  Sales: ['dashboard', 'orders', 'customers', 'more'],
  Inventory: ['dashboard', 'products', 'more'],
};
const ROLE_MORE_ACTIONS: { [role: string]: string[] } = {
  Sales: ['store', 'share-store', 'pos', 'invoices', 'coupons', 'help'],
  Inventory: ['store', 'share-store', 'bundles', 'help'],
};
// The platform's real logo everywhere the old placeholder "SP" badge used to be - falls back
// to that same badge if no logo has been set, so nothing ever shows broken or blank.
function AppLogo({ size }: { size: number }) {
  const [imageFailed, setImageFailed] = useState(false);
  if (PLATFORM_LOGO_URL && !imageFailed) {
    return <img src={PLATFORM_LOGO_URL} alt="SalesPilot" onError={() => setImageFailed(true)} style={{ width: size, height: size, borderRadius: size >= 44 ? 12 : 8, objectFit: 'cover' as const, flexShrink: 0 }} />;
  }
  return (
    <div style={{ width: size, height: size, background: C.green, borderRadius: size >= 44 ? 12 : 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, color: 'white', fontSize: size >= 44 ? 16 : 13, flexShrink: 0 }}>SP</div>
  );
}

function canAccessTab(user: any, tabId: string): boolean {
  if (tabId === 'orders' && user?.sellingMode === 'in-person') return false;
  if (!user?.isStaff || !user?.staffRole) return true;
  const allowed = ROLE_TABS[user.staffRole];
  return !allowed || allowed.includes(tabId);
}
function canAccessMoreAction(user: any, action: string): boolean {
  if (!user?.isStaff || !user?.staffRole) return true;
  const allowed = ROLE_MORE_ACTIONS[user.staffRole];
  return !allowed || allowed.includes(action);
}

// A merchant has "Pro access" if they're still within their 14-day free trial (full access to
// everything, regardless of which plan they picked at signup, so they can properly evaluate
// Pro before choosing), OR if they've actually paid for Pro and that payment hasn't expired yet.
// Just having "plan: 'pro'" saved from signup is NOT enough on its own once the trial is over -
// that used to be a real bug (an account could pick Pro at signup and keep full access forever
// without ever paying) - real Pro access now requires a genuine, unexpired subscription payment.
// Backend error responses don't always come back as a plain string - some (like Resend's own
// validation errors) are nested objects with their own {statusCode, name, message} shape. This
// always returns something safe to put directly into JSX, never the raw object itself - React
// throws a hard crash (minified error #31) if an object is ever rendered as a child directly.
function extractErrorMessage(body: any): string {
  if (!body) return '';
  const raw = body.detail ?? body.error ?? body.message ?? '';
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') return raw.message || JSON.stringify(raw);
  return '';
}

// Captures a referral code from a link like salespilot.com.ng/?ref=CODE the moment someone
// lands on the site, and keeps it around in sessionStorage through however many pages they
// browse before actually signing up - the same pattern already used to track storefront
// marketing channels, just for the main app's own signups instead.
function captureReferralCode() {
  try {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref');
    if (ref) sessionStorage.setItem('sp_referral_code', ref);
  } catch {}
}

function getReferralCode(): string {
  try {
    return sessionStorage.getItem('sp_referral_code') || '';
  } catch {
    return '';
  }
}

function isProAccess(user: any): boolean {
  if (!user) return false;
  if (user.trialStart) {
    const elapsedDays = Math.floor((Date.now() - new Date(user.trialStart).getTime()) / (1000 * 60 * 60 * 24));
    if (elapsedDays < 14) return true;
  }
  if (user.plan === 'pro' && user.subscriptionExpiresAt) {
    return new Date(user.subscriptionExpiresAt).getTime() > Date.now();
  }
  return false;
}

// How many credits an email costs to send, matching Bumpa's own rate - merchants coming from
// Bumpa will already recognize this cost, rather than SalesPilot inventing a new number.
const CREDITS_PER_EMAIL = 4;

// Free messaging credits refreshed every calendar month, tied to plan. This exists specifically
// to keep any one merchant from hogging the platform's shared email-sending capacity - it does
// NOT by itself protect against the platform running out of its own underlying email quota
// (that's a separate, real decision about upgrading the email provider's own plan as real usage
// grows) - this is purely a fairness/allocation system between merchants.
function getMessagingCreditsAllowance(user: any): number {
  return isProAccess(user) ? 500 : 100;
}

function getMonthKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// Tops a merchant's credits back up to their plan's free monthly allowance if the calendar
// month has changed since they were last refreshed. Called wherever credits are checked or
// spent, so no separate scheduled job is needed to keep this current.
async function ensureCreditsRefreshed(user: any, updateProfile: (data: any) => Promise<void>) {
  if (!user?.uid) return;
  const currentMonth = getMonthKey();
  const lastResetMonth = user.creditsResetAt ? getMonthKey(new Date(user.creditsResetAt)) : null;
  if (lastResetMonth !== currentMonth) {
    const allowance = getMessagingCreditsAllowance(user);
    await updateProfile({ messagingCredits: allowance, creditsResetAt: new Date().toISOString() });
  }
}

// More-menu actions that require Pro (or an active trial) to actually open. Tapping one of
// these while not on Pro redirects to the Subscription screen instead of the real feature.
const PRO_ONLY_ACTIONS = ['staff', 'email-campaign', 'connected-tools'];

// Sends an email via the Vercel backend. Silently logs failure rather than throwing, so an
// email hiccup never blocks whatever the merchant is doing in the dashboard.
// The one account that can see the Owner Dashboard - checked by email, not by any special
// database flag, so there's nothing else to configure. Update this if the owner's account
// email ever changes.
const OWNER_EMAIL = 'shedrackisrael54@gmail.com';

function isOwner(user: any): boolean {
  return !!user?.email && user.email.toLowerCase() === OWNER_EMAIL.toLowerCase();
}

// Records that an email was actually sent, so the Owner Dashboard can show real usage against
// Resend's shared 100/day free-tier limit - this is the one number that can silently break real
// signups and order confirmations for every merchant at once if it's ever crossed without
// anyone noticing. Stored on a single shared document, keyed by today's date, reset naturally
// each new day simply by writing to a new date-keyed field.
async function trackEmailSent() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await setDoc(doc(db, 'platformStats', 'emailUsage'), { [today]: increment(1) }, { merge: true });
  } catch (err) {
    console.error('Could not track email usage:', err);
  }
}

async function sendStoreEmail(to: string, subject: string, html: string) {
  try {
    await fetch('https://sales-pilot-payment.vercel.app/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, html }),
    });
    trackEmailSent();
  } catch (err) {
    console.error('Could not send email:', err);
  }
}

function buildStatusUpdateEmail(order: Order, storeName: string): string {
  const statusMessage: any = {
    Processing: 'Your order is being processed and will be shipped soon.',
    Completed: 'Your order is complete! Thanks for shopping with us.',
    Cancelled: 'Your order has been cancelled. Contact the seller if you have questions.',
    Pending: 'Your order is pending confirmation.',
  };
  return `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#111827;">
      <h2 style="margin-bottom:4px;">Order Update</h2>
      <p style="color:#6B7280;margin-top:0;">${storeName} - Ref: ${order.reference}</p>
      <p style="font-size:16px;font-weight:bold;margin:16px 0 4px;">Status: ${order.status}</p>
      <p style="font-size:14px;color:#374151;">${statusMessage[order.status] || ''}</p>
      <p style="font-size:13px;color:#9CA3AF;margin-top:24px;">Total: ${NAIRA}${order.total.toLocaleString()}</p>
    </div>
  `;
}

function AuthProvider({ children }: any) {
  const [user, setUser] = useState<any>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      try {
        if (firebaseUser) {
          const merchantSnap = await getDoc(doc(db, 'merchants', firebaseUser.uid));
          if (merchantSnap.exists()) {
            setUser({ uid: firebaseUser.uid, email: firebaseUser.email, ...merchantSnap.data(), isStaff: false });
          } else {
            const lookupSnap = await getDoc(doc(db, 'staffLookup', firebaseUser.uid));
            if (lookupSnap.exists()) {
              const lookup: any = lookupSnap.data();
              const merchantProfileSnap = await getDoc(doc(db, 'merchants', lookup.merchantUid));
              const profile = merchantProfileSnap.exists() ? merchantProfileSnap.data() : {};
              setUser({ uid: lookup.merchantUid, email: firebaseUser.email, ...profile, isStaff: true, staffRole: lookup.role, staffAuthUid: firebaseUser.uid, staffName: lookup.name });
            } else {
              setUser(null);
            }
          }
        } else {
          setUser(null);
        }
      } catch (err) {
        // If the account lookup fails (a network hiccup, a temporary Firestore issue), fall back
        // to signed-out rather than leaving the app stuck - authReady below must always fire
        // regardless, or the splash screen waiting on it would never dismiss.
        setUser(null);
      } finally {
        setAuthReady(true);
      }
    });
    return unsub;
  }, []);

  const signup = async (email: string, password: string, name: string) => {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const referredBy = getReferralCode();
    const profile: any = { name, email, storeName: '', onboardingComplete: false };
    if (referredBy) profile.referredBy = referredBy;
    await setDoc(doc(db, 'merchants', cred.user.uid), profile);
    if (referredBy) {
      try { await setDoc(doc(db, 'referrers', referredBy), { referredCount: increment(1) }, { merge: true }); } catch {}
    }
    setUser({ uid: cred.user.uid, ...profile, isStaff: false });
  };

  const loginWithPassword = async (email: string, password: string) => {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const merchantSnap = await getDoc(doc(db, 'merchants', cred.user.uid));
    if (merchantSnap.exists()) {
      setUser({ uid: cred.user.uid, email: cred.user.email, ...merchantSnap.data(), isStaff: false });
    } else {
      const lookupSnap = await getDoc(doc(db, 'staffLookup', cred.user.uid));
      if (lookupSnap.exists()) {
        const lookup: any = lookupSnap.data();
        const merchantProfileSnap = await getDoc(doc(db, 'merchants', lookup.merchantUid));
        const profile = merchantProfileSnap.exists() ? merchantProfileSnap.data() : {};
        setUser({ uid: lookup.merchantUid, email: cred.user.email, ...profile, isStaff: true, staffRole: lookup.role, staffAuthUid: cred.user.uid, staffName: lookup.name });
      }
    }
  };

  // Shared by both Google and Apple sign-in: same account either way could be a brand new
  // merchant (create their profile now, just like email signup does) or someone returning
  // (load their existing profile) - one flow handles both cases, same as tapping the button
  // works for "sign up" and "sign in" without the person needing to pick which one they meant.
  const loginWithOAuthProvider = async (provider: any) => {
    const cred = await signInWithPopup(auth, provider);
    const merchantSnap = await getDoc(doc(db, 'merchants', cred.user.uid));
    if (merchantSnap.exists()) {
      setUser({ uid: cred.user.uid, email: cred.user.email, ...merchantSnap.data(), isStaff: false });
    } else {
      const referredBy = getReferralCode();
      const profile: any = { name: cred.user.displayName || '', email: cred.user.email || '', storeName: '', onboardingComplete: false };
      if (referredBy) profile.referredBy = referredBy;
      await setDoc(doc(db, 'merchants', cred.user.uid), profile);
      if (referredBy) {
        try { await setDoc(doc(db, 'referrers', referredBy), { referredCount: increment(1) }, { merge: true }); } catch {}
      }
      setUser({ uid: cred.user.uid, ...profile, isStaff: false });
    }
  };

  const loginWithGoogle = () => loginWithOAuthProvider(new GoogleAuthProvider());
  const loginWithApple = () => loginWithOAuthProvider(new OAuthProvider('apple.com'));

  const resetPassword = (email: string) => sendPasswordResetEmail(auth, email);

  const updateProfile = async (data: any) => {
    if (!user?.uid) return;
    await setDoc(doc(db, 'merchants', user.uid), data, { merge: true });
    setUser((prev: any) => ({ ...prev, ...data }));
  };

  const logout = () => signOut(auth);

  return (
    <AuthContext.Provider value={{ user, authReady, signup, loginWithPassword, loginWithGoogle, loginWithApple, resetPassword, updateProfile, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

const C = {
  navy: '#142A45',
  navyLight: '#1E3A5F',
  green: '#10B981',
  greenLight: '#D1FAE5',
  bg: '#F0F6FF',
  white: '#FFFFFF',
  dark: '#111827',
  gray: '#6B7280',
  border: '#E5E7EB',
  orange: '#F59E0B',
  orangeLight: '#FEF3C7',
  blue: '#3B82F6',
  blueLight: '#DBEAFE',
  purple: '#8B5CF6',
  purpleLight: '#EDE9FE',
};

type Coupon = {
  id: string;
  code: string;
  type: 'percent' | 'fixed';
  value: number;
  usageLimit: number | null;
  usedCount: number;
  active: boolean;
  startDate?: string;
  endDate?: string;
  createdAt: string;
};

type Expense = {
  id: string;
  title: string;
  amount: number;
  category: 'Stock' | 'Transport' | 'Packaging' | 'Marketing' | 'Other';
  note?: string;
  date: string;
  createdAt: string;
};

type InvoiceItem = {
  description: string;
  quantity: number;
  unitPrice: number;
  productId?: string;
};

type Invoice = {
  id: string;
  invoiceNumber: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  items: InvoiceItem[];
  note?: string;
  date: string;
  dueDate?: string;
  paid: boolean;
  createdAt: string;
};

type POSSale = {
  id: string;
  customerName?: string;
  items: { description: string; quantity: number; unitPrice: number; productId?: string }[];
  total: number;
  paymentMethod: 'Cash' | 'Transfer' | 'POS' | 'Other';
  date: string;
  createdAt: string;
};

type StaffRole = 'Admin' | 'Sales' | 'Inventory';

type StaffMember = {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  invitedAt: string;
  status: 'pending' | 'active';
  inviteCode: string;
  linkedAuthUid?: string;
};

type CustomerRecord = {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  notes?: string;
  createdAt: string;
};

const statusConfig: any = {
  Pending: { bg: C.orangeLight, color: C.orange },
  Processing: { bg: C.blueLight, color: C.blue },
  Completed: { bg: C.greenLight, color: C.green },
  Cancelled: { bg: '#FEE2E2', color: '#EF4444' },
};

const badgeConfig: any = {
  Hot: { bg: '#FEE2E2', color: '#EF4444' },
  New: { bg: C.greenLight, color: C.green },
  Sale: { bg: C.orangeLight, color: C.orange },
};

const stockConfig: any = {
  'In stock': { bg: C.greenLight, color: C.green },
  'Low stock': { bg: C.orangeLight, color: C.orange },
  'Out of stock': { bg: '#FEE2E2', color: '#EF4444' },
};

function BottomNav({ active, setActive, user }: any) {
  const allTabs = [
    { id: 'dashboard', label: 'Dashboard', Icon: Home },
    { id: 'orders', label: 'Orders', Icon: ShoppingBag },
    { id: 'products', label: 'Products', Icon: Package },
    { id: 'customers', label: 'Customers', Icon: Users },
    { id: 'more', label: 'More', Icon: MoreHorizontal },
  ];
  const tabs = allTabs.filter(t => canAccessTab(user, t.id));
  return (
    <div style={{ position: 'fixed' as const, bottom: 0, left: 0, right: 0, background: C.white, borderTop: `1px solid ${C.border}`, display: 'flex', padding: '8px 0 16px', boxShadow: '0 -4px 20px rgba(0,0,0,0.08)', zIndex: 100 }}>
      {tabs.map(({ id, label, Icon }) => (
        <button key={id} onClick={() => setActive(id)} style={{ flex: 1, background: 'transparent', border: 'none', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 4, cursor: 'pointer', padding: '4px 0' }}>
          <Icon size={22} color={active === id ? C.navy : C.gray} strokeWidth={active === id ? 2.5 : 1.5} />
          <span style={{ fontSize: 10, fontWeight: active === id ? 700 : 500, color: active === id ? C.navy : C.gray }}>{label}</span>
          {active === id && <div style={{ width: 4, height: 4, background: C.navy, borderRadius: '50%' }} />}
        </button>
      ))}
    </div>
  );
}

interface DashboardInfoBlock {
  heading?: string;
  text: string;
}

interface DashboardInfoCard {
  id: string;
  icon: 'about' | 'guide' | 'features' | 'support';
  teaserTitle: string;
  teaserSubtitle: string;
  teaserCta: string;
  fullTitle: string;
  content: DashboardInfoBlock[];
  imageUrl?: string;
}

const DASHBOARD_INFO_CARDS: DashboardInfoCard[] = [
  {
    id: 'about',
    icon: 'about',
    teaserTitle: 'About SalesPilot',
    teaserSubtitle: 'Built for Nigerian sellers',
    teaserCta: 'Tap to learn more',
    fullTitle: 'About SalesPilot',
    imageUrl: 'https://res.cloudinary.com/xd2hkwf8/image/upload/v1785092640/file_00000000a8ac81f49f7751355a202afa_nvhqo6.png',
    content: [
      { text: "SalesPilot exists because running a business in Nigeria shouldn't require a developer, a laptop, or deep pockets." },
      { text: 'Whether you sell clothes, electronics, food, or anything in between, you deserve a real, professional storefront that works the way you actually sell: sometimes online, sometimes in person, sometimes both in the same day.' },
      { text: 'SalesPilot is built entirely for that reality. Mobile first, made to be run from your phone, with everything connected: your stock, your sales, your customers, your money.' },
      { text: 'No big tech company built this for a global market and hoped it would work here. This was built specifically for you.' },
    ],
  },
  {
    id: 'guide',
    icon: 'guide',
    teaserTitle: 'How to Use SalesPilot',
    teaserSubtitle: 'A quick guide to get you started',
    teaserCta: 'Tap to read',
    fullTitle: 'How to Use SalesPilot',
    imageUrl: 'https://res.cloudinary.com/xd2hkwf8/image/upload/v1785095709/IMG_20260726_205422_njd9oo.png',
    content: [
      { heading: 'Getting Started', text: 'Set up your store. Go to More, then Complete Your Store, to add your logo, bank details, and contact info. This matters because it is what makes your store look like a real business instead of a random link, and it is how you actually get paid correctly when orders come in.' },
      { text: 'Add your first product. Tap Add Product on your dashboard. Add real photos (customers buy what they can clearly see), set your price, and enter your actual stock quantity. If you sell in bulk, turn on tiered pricing so buyers automatically get a better price per unit the more they order, no manual math needed on your end.' },
      { text: 'Pick your look. Go to More, then Brand Studio, to choose from 32 themes. Your store colors and style should match your brand, not look like every other seller default page. This is what makes your store feel like yours.' },
      { text: 'Share your store. Tap Share Store to get your unique store link. This one link is your entire shop. Post it on WhatsApp, Instagram, or anywhere your customers already spend time, and they can browse and buy without ever needing to download anything.' },
      { heading: 'Selling Day to Day', text: 'Selling online. When a customer orders through your store, everything happens on its own: payment is collected safely, your stock count goes down automatically, and the customer gets an email confirming their order. You do not have to manually update anything.' },
      { text: 'Selling in person. Use POS when someone buys from you face to face. It records the sale and updates your stock instantly, so your online and offline numbers never fall out of sync. Use Invoices when you need to send a customer a proper, professional bill they can pay later. If your products have barcodes, scan them at checkout to add items instantly instead of searching for them.' },
      { text: 'Track your orders. The Orders screen shows everything coming in, lets you update statuses so customers know what is happening, and shows you which delivery courier a customer chose, so you know exactly how to get their order to them.' },
      { heading: 'Growing Your Business', text: 'Understand your numbers. Analytics is not just numbers for the sake of it. It shows you which products are actually selling, how much real profit you are making, and where your customers are finding you, so you know where to focus your effort.' },
      { text: 'Bring in help. Once you are too busy to do everything alone, add staff under More, then Staff Accounts. You control exactly what they can see and touch, so you can delegate sales or inventory work without handing over your entire business.' },
      { text: 'Market smarter. Run coupons to bring in hesitant buyers, add a countdown to your next sale, or connect Facebook Pixel so your ads actually learn who buys from you, all built in, no extra tools to pay for.' },
      { text: 'Explore the More menu often. That is where most of SalesPilot power quietly lives.' },
    ],
  },
  {
    id: 'features',
    icon: 'features',
    teaserTitle: 'Your Unfair Advantage',
    teaserSubtitle: 'Tools that quietly change everything',
    teaserCta: "Tap to see what's possible",
    fullTitle: 'Your Unfair Advantage',
    imageUrl: 'https://res.cloudinary.com/xd2hkwf8/image/upload/v1785103429/file_00000000165481f4ac717337c6082bbe_euccr4.png',
    content: [
      { text: 'Some stores just sell. Others grow on purpose. Here is what that actually looks like, and exactly where to find it.' },
      { heading: 'Bring In Help', text: 'You do not have to run this alone forever. Bring on a sales assistant to handle orders while you handle products, or a trusted staff member for inventory, each with only the access they actually need, nothing more.' },
      { text: 'Find it: More, then Staff Accounts' },
      { heading: "Know Exactly What's Working", text: '"Total sales" does not tell you what to do next. Real insight shows which product is actually your top seller, and which marketing channel brings your best customers, so you know exactly where to spend your next hour.' },
      { text: 'Find it: More, then Analytics' },
      { heading: 'Speak To The Right Customer, The Right Way', text: 'Not everyone who buys from you is the same. Your regulars deserve a different message than a first-time visitor, and now you can actually tell them apart.' },
      { text: 'Find it: Customers tab, tap any customer, then add them to a group' },
      { heading: 'Make Every Naira Spent Smarter', text: 'Every Naira spent on ads should teach your ads to work better. Connect your tracking, and your marketing gets sharper with every sale, instead of guessing blind each time.' },
      { text: 'Find it: More, then Connected Tools' },
      { text: 'This is what it looks like when a store stops guessing and starts growing on purpose.' },
    ],
  },
  {
    id: 'support',
    icon: 'support',
    teaserTitle: "You're Not Alone in This",
    teaserSubtitle: 'Real support, whenever you need it',
    teaserCta: 'Tap to learn more',
    fullTitle: "You're Not Alone in This",
    imageUrl: 'https://res.cloudinary.com/xd2hkwf8/image/upload/v1785104715/file_00000000f13c81f4978fe89ed5d6973c_hz7uvo.png',
    content: [
      { text: 'Running a business is hard. Some days it is stock that will not add up, a customer who will not pay, or just not knowing if you are doing things the right way. SalesPilot exists to make those days easier, not harder.' },
      { text: 'When something is not working or you are not sure how to do something, you are not on your own. Reach out and you will get a real, direct response from a team that actually understands the platform you are using and the business you are running.' },
      { text: 'SalesPilot grows because of the sellers who use it. Features get added because real merchants ask for them and tell us what would genuinely make running their business easier. If something is missing, say so. That is exactly how most of what you are using today came to exist.' },
      { text: "You did not start your business to become a tech expert. You started it to sell, to earn, to build something that is yours. SalesPilot's job is to handle the technical side so you can focus on that. And whenever we are not doing that job well enough, that is on us to fix, and we will." },
      { text: 'Explore the More menu whenever you need to. And if you are ever stuck, just ask.' },
    ],
  },
];

const DASHBOARD_INFO_ICON_MAP: { [key: string]: any } = {
  about: Info,
  guide: BookOpen,
  features: Sparkles,
  support: HeartHandshake,
};

const DASHBOARD_INFO_GRADIENT_MAP: { [key: string]: string } = {
  about: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`,
  guide: `linear-gradient(135deg, #059669, ${C.green})`,
  features: `linear-gradient(135deg, #6D28D9, ${C.purple})`,
  support: `linear-gradient(135deg, #BE185D, #F472B6)`,
};

function DashboardInfoCardFace({ card, onSelect }: { card: DashboardInfoCard; onSelect: (card: DashboardInfoCard) => void }) {
  const Icon = DASHBOARD_INFO_ICON_MAP[card.icon];
  const gradient = DASHBOARD_INFO_GRADIENT_MAP[card.icon];
  return (
    <button
      onClick={() => onSelect(card)}
      style={{
        flex: '0 0 78%', scrollSnapAlign: 'start' as const, background: card.imageUrl ? '#111' : gradient, borderRadius: 20, padding: 20,
        textAlign: 'left' as const, border: 'none', boxShadow: '0 10px 24px rgba(0,0,0,0.16)', cursor: 'pointer',
        position: 'relative' as const, overflow: 'hidden', minHeight: 168,
      }}
    >
      {card.imageUrl ? (
        <>
          <img src={getOptimizedImageUrl(card.imageUrl, 500)} alt="" style={{ position: 'absolute' as const, inset: 0, width: '100%', height: '100%', objectFit: 'cover' as const }} loading="lazy" />
          <div style={{ position: 'absolute' as const, inset: 0, background: `linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.35) 55%, rgba(0,0,0,0.82) 100%)` }} />
        </>
      ) : (
        <>
          <div style={{ position: 'absolute' as const, width: 120, height: 120, borderRadius: '50%', background: 'rgba(255,255,255,0.08)', top: -50, right: -40 }} />
          <div style={{ position: 'absolute' as const, width: 70, height: 70, borderRadius: '50%', background: 'rgba(255,255,255,0.06)', bottom: -20, left: -20 }} />
        </>
      )}
      <div style={{ position: 'relative' as const, zIndex: 1 }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
          <Icon size={22} color="white" />
        </div>
        <p style={{ fontSize: 16.5, fontWeight: 800, color: 'white', marginBottom: 5, textAlign: 'left' as const }}>{card.teaserTitle}</p>
        <p style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.85)', marginBottom: 16, lineHeight: 1.4, textAlign: 'left' as const }}>{card.teaserSubtitle}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <p style={{ fontSize: 12, fontWeight: 700, color: 'white' }}>{card.teaserCta}</p>
          <ArrowRight size={13} color="white" />
        </div>
      </div>
    </button>
  );
}

function DashboardInfoCarousel({ onSelect }: { onSelect: (card: DashboardInfoCard) => void }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h3 style={{ fontSize: 16, fontWeight: 700, color: C.dark, marginBottom: 12 }}>Learn SalesPilot</h3>
      <div style={{ display: 'flex', gap: 12, overflowX: 'auto' as const, scrollSnapType: 'x mandatory' as const, paddingBottom: 4 }}>
        {DASHBOARD_INFO_CARDS.map(card => (
          <DashboardInfoCardFace key={card.id} card={card} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

function DashboardScreen({ user, onNavigate }: any) {
  const [filter, setFilter] = useState('Today');
  const [products, setProducts] = useState<Product[]>([]);
  const [recentOrders, setRecentOrders] = useState<Order[]>([]);
  const [allPOSSales, setAllPOSSales] = useState<any[]>([]);
  const [allInvoices, setAllInvoices] = useState<any[]>([]);
  const [expenseTotal, setExpenseTotal] = useState(0);
  const [copiedStoreLink, setCopiedStoreLink] = useState(false);
  const [activeInfoCard, setActiveInfoCard] = useState<DashboardInfoCard | null>(null);

  useEffect(() => {
    if (!user?.uid) return;
    const unsubProducts = onSnapshot(collection(db, 'merchants', user.uid, 'products'), (snap) => {
      const list: Product[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).filter((p: any) => !p._deleted);
      setProducts(list);
    });
    const unsubOrders = onSnapshot(collection(db, 'merchants', user.uid, 'orders'), (snap) => {
      const list: Order[] = snap.docs
        .map(d => ({ id: d.id, ...(d.data() as any) }))
        .sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      setRecentOrders(list);
    });
    const unsubExpenses = onSnapshot(collection(db, 'merchants', user.uid, 'expenses'), (snap) => {
      const thisMonth = new Date().toISOString().slice(0, 7);
      const total = snap.docs
        .map(d => d.data() as any)
        .filter(e => !e._deleted && e.date?.slice(0, 7) === thisMonth)
        .reduce((sum, e) => sum + (e.amount || 0), 0);
      setExpenseTotal(total);
    });
    const unsubPOS = onSnapshot(collection(db, 'merchants', user.uid, 'pos_sales'), (snap) => {
      setAllPOSSales(snap.docs.map(d => d.data() as any).filter(s => !s._deleted));
    });
    const unsubInvoices = onSnapshot(collection(db, 'merchants', user.uid, 'invoices'), (snap) => {
      setAllInvoices(snap.docs.map(d => d.data() as any).filter(i => !i._deleted));
    });
    return () => { unsubProducts(); unsubOrders(); unsubExpenses(); unsubPOS(); unsubInvoices(); };
  }, [user?.uid]);

  // Returns true if a date string (YYYY-MM-DD) falls within the selected period
  const inPeriod = (dateStr: string | undefined): boolean => {
    if (!dateStr) return false;
    const d = dateStr.slice(0, 10);
    const now = new Date();
    if (filter === 'Today') {
      return d === now.toISOString().slice(0, 10);
    }
    if (filter === 'This Week') {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      return d >= weekAgo.toISOString().slice(0, 10);
    }
    // This Month
    return d.slice(0, 7) === now.toISOString().slice(0, 7);
  };

  const periodOrderSales = recentOrders
    .filter(o => inPeriod(o.createdAt) && o.status !== 'Cancelled' && o.status !== 'Pending')
    .reduce((sum, o) => sum + (o.total || 0), 0);
  const periodPOSSales = allPOSSales
    .filter(s => inPeriod(s.date))
    .reduce((sum, s) => sum + (s.total || 0), 0);
  const periodInvoiceSales = allInvoices
    .filter(i => i.paid && inPeriod(i.date))
    .reduce((sum, i) => sum + (i.items || []).reduce((s: number, it: any) => s + it.quantity * it.unitPrice, 0), 0);
  const periodRevenue = periodOrderSales + periodPOSSales + periodInvoiceSales;

  const lowStockCount = products.filter(p => p.status === 'Low stock' || p.status === 'Out of stock').length;
  const estimatedProfit = periodRevenue - expenseTotal;

  // Real best sellers, aggregated across online orders, POS sales, and paid invoices (all time)
  const salesByProduct: { [key: string]: { qty: number } } = {};
  const bumpSales = (key: string | undefined, qty: number) => {
    if (!key) return;
    if (!salesByProduct[key]) salesByProduct[key] = { qty: 0 };
    salesByProduct[key].qty += qty;
  };
  recentOrders.forEach(o => (o.items || []).forEach((it: any) => bumpSales(it.productId, it.quantity)));
  allPOSSales.forEach(s => (s.items || []).forEach((it: any) => bumpSales(it.productId, it.quantity)));
  allInvoices.forEach(inv => inv.paid && (inv.items || []).forEach((it: any) => bumpSales(it.productId, it.quantity)));
  const bestSelling = products
    .map(p => ({ product: p, sold: salesByProduct[p.id]?.qty || 0 }))
    .filter(x => x.sold > 0)
    .sort((a, b) => b.sold - a.sold)
    .slice(0, 3);

  // Unique customers across all real sales sources this store has ever had
  const customerKeys = new Set<string>();
  recentOrders.forEach(o => { if (o.customerName) customerKeys.add(o.customerName.trim().toLowerCase()); });
  allPOSSales.forEach(s => { if (s.customerName) customerKeys.add(s.customerName.trim().toLowerCase()); });
  allInvoices.forEach(i => { if (i.customerName) customerKeys.add(i.customerName.trim().toLowerCase()); });
  const totalCustomers = customerKeys.size;

  const TRIAL_LENGTH_DAYS = 14;
  let trialDaysLeft: number | null = null;
  let trialExpired = false;
  if (user?.trialStart) {
    const startedAt = new Date(user.trialStart).getTime();
    const elapsedDays = Math.floor((Date.now() - startedAt) / (1000 * 60 * 60 * 24));
    trialDaysLeft = Math.max(TRIAL_LENGTH_DAYS - elapsedDays, 0);
    trialExpired = trialDaysLeft <= 0;
  }

  const setupItemsDone = [
    !!(user?.bankName && user?.accountNumber && user?.accountName),
    !!(user?.state && user?.zipcode),
    !!(user?.contactWhatsapp && user?.contactEmail),
    !!user?.storeDescription,
    !!user?.logoUrl,
  ].filter(Boolean).length;
  const setupComplete = setupItemsDone === 5;

  const storeLink = user?.storeSlug ? `${window.location.origin}/${user.storeSlug}` : null;

  const handleCopyStoreLink = () => {
    if (!storeLink) return;
    copyToClipboard(storeLink);
    setCopiedStoreLink(true);
    setTimeout(() => setCopiedStoreLink(false), 1500);
  };

  const handleViewStore = () => {
    if (!storeLink) return;
    window.open(storeLink, '_blank');
  };

  const [unreadNotifCount, setUnreadNotifCount] = useState(0);
  useEffect(() => {
    if (!user?.uid) return;
    const q = query(collection(db, 'merchants', user.uid, 'notifications'), orderBy('createdAt', 'desc'), fsLimit(50));
    const unsub = onSnapshot(q, (snap) => {
      setUnreadNotifCount(snap.docs.filter(d => !(d.data() as any).read).length);
    }, () => {});
    return unsub;
  }, [user?.uid]);

  if (activeInfoCard) {
    const Icon = DASHBOARD_INFO_ICON_MAP[activeInfoCard.icon];
    const gradient = DASHBOARD_INFO_GRADIENT_MAP[activeInfoCard.icon];
    return (
      <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
        <div style={{ background: activeInfoCard.imageUrl ? '#111' : gradient, padding: activeInfoCard.imageUrl ? '20px 20px 40px' : '20px 20px 28px', position: 'relative' as const, overflow: 'hidden' }}>
          {activeInfoCard.imageUrl ? (
            <>
              <img src={getOptimizedImageUrl(activeInfoCard.imageUrl, 900)} alt="" style={{ position: 'absolute' as const, inset: 0, width: '100%', height: '100%', objectFit: 'cover' as const }} />
              <div style={{ position: 'absolute' as const, inset: 0, background: `linear-gradient(180deg, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.4) 55%, rgba(0,0,0,0.85) 100%)` }} />
            </>
          ) : (
            <div style={{ position: 'absolute' as const, width: 130, height: 130, borderRadius: '50%', background: 'rgba(255,255,255,0.08)', top: -50, right: -30 }} />
          )}
          <button onClick={() => setActiveInfoCard(null)} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', marginBottom: 16, position: 'relative' as const, zIndex: 1 }}>
            <ArrowLeft size={18} color="white" />
          </button>
          <div style={{ width: 46, height: 46, borderRadius: 13, background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14, position: 'relative' as const, zIndex: 1 }}>
            <Icon size={23} color="white" />
          </div>
          <h2 style={{ color: 'white', fontSize: 21, fontWeight: 800, position: 'relative' as const, zIndex: 1 }}>{activeInfoCard.fullTitle}</h2>
        </div>
        <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>
          {activeInfoCard.content.map((block, i) => {
            const isFindIt = block.text.startsWith('Find it:');
            return (
              <div key={i} style={{ marginBottom: isFindIt ? 16 : 8, textAlign: 'left' as const }}>
                {block.heading && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: i > 0 ? 8 : 0 }}>
                    <div style={{ width: 4, height: 16, borderRadius: 2, background: gradient, flexShrink: 0 }} />
                    <p style={{ fontSize: 15, fontWeight: 800, color: C.dark, textAlign: 'left' as const }}>{block.heading}</p>
                  </div>
                )}
                {isFindIt ? (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: C.bg, borderRadius: 10, padding: '7px 12px', marginTop: 4 }}>
                    <MapPin size={12} color={C.navy} />
                    <p style={{ fontSize: 12.5, fontWeight: 700, color: C.navy }}>{block.text.replace('Find it: ', '')}</p>
                  </div>
                ) : (
                  <p style={{ fontSize: 14, color: C.dark, lineHeight: 1.65, textAlign: 'left' as const }}>{block.text}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy} 0%, ${C.navyLight} 100%)`, padding: '16px 20px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginBottom: 2 }}>{user?.isStaff ? `Signed in as ${user.staffRole}` : 'Good morning,'}</p>
            <h2 style={{ color: 'white', fontSize: 20, fontWeight: 700 }}>Hello, {user?.isStaff ? user.staffName : (user?.storeName || user?.name || 'Merchant')}</h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: C.green, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: 'white', border: '2px solid rgba(255,255,255,0.3)', overflow: 'hidden' }}>
              {user?.profilePhotoUrl ? (
                <img src={user.profilePhotoUrl} alt={user?.name || 'Profile'} style={{ width: '100%', height: '100%', objectFit: 'cover' as const }} />
              ) : (
                user?.name?.[0] || 'M'
              )}
            </div>
            <div style={{ position: 'relative' as const }}>
              <button onClick={() => onNavigate?.('notifications')} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <Bell size={20} color="white" />
              </button>
              {unreadNotifCount > 0 && (
                <div style={{ position: 'absolute' as const, top: -4, right: -4, background: C.orange, borderRadius: '50%', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: 'white' }}>{unreadNotifCount > 9 ? '9+' : unreadNotifCount}</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: '0 16px', marginTop: -16 }}>

        {/* View / Copy Store bar */}
        {user?.sellingMode !== 'in-person' && (
          <div style={{ background: C.white, borderRadius: 16, padding: '14px 16px', marginBottom: 16, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: storeLink ? 12 : 0 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: C.blueLight, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Store size={17} color={C.blue} />
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: C.dark }}>Your store</p>
                <p style={{ fontSize: 11, color: C.gray, overflow: 'hidden', textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
                  {storeLink ? storeLink.replace('https://', '') : 'Finish setup to get your store link'}
                </p>
              </div>
            </div>
            {storeLink && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleViewStore} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: C.navy, color: 'white', border: 'none', borderRadius: 10, padding: '10px 0', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                  <ExternalLink size={13} /> View Store
                </button>
                <button onClick={handleCopyStoreLink} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: C.bg, color: C.navy, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: '10px 0', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                  <Copy size={13} /> {copiedStoreLink ? 'Copied!' : 'Copy Link'}
                </button>
              </div>
            )}
          </div>
        )}

        {trialDaysLeft !== null && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, borderRadius: 14, padding: '12px 14px', marginBottom: 16,
            background: trialExpired ? '#FEE2E2' : trialDaysLeft <= 3 ? C.orangeLight : C.white,
            boxShadow: trialExpired || trialDaysLeft <= 3 ? 'none' : '0 2px 12px rgba(0,0,0,0.06)',
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: trialExpired ? '#FECACA' : trialDaysLeft <= 3 ? '#FDE68A' : C.greenLight,
            }}>
              {trialExpired ? <Clock size={16} color="#991B1B" /> : trialDaysLeft <= 3 ? <AlertCircle size={16} color="#92400E" /> : <Gift size={16} color={C.green} />}
            </div>
            <div style={{ flex: 1 }}>
              {trialExpired ? (
                <>
                  <p style={{ fontSize: 13, fontWeight: 700, color: '#991B1B' }}>Your free trial has ended</p>
                  <p style={{ fontSize: 12, color: '#991B1B' }}>Upgrade now to keep your store running</p>
                </>
              ) : (
                <>
                  <p style={{ fontSize: 13, fontWeight: 700, color: trialDaysLeft <= 3 ? '#92400E' : C.dark }}>
                    {trialDaysLeft} day{trialDaysLeft !== 1 ? 's' : ''} left on your free trial
                  </p>
                  <p style={{ fontSize: 12, color: trialDaysLeft <= 3 ? '#92400E' : C.gray }}>
                    {trialDaysLeft <= 3 ? 'Upgrade soon to avoid losing access' : `Enjoying ${user?.plan === 'pro' ? 'Growth' : 'Starter'}? You can upgrade anytime`}
                  </p>
                </>
              )}
            </div>
            <button onClick={() => onNavigate?.('subscription')} style={{
              background: trialExpired ? '#EF4444' : C.navy, color: 'white', border: 'none', borderRadius: 10, padding: '8px 14px',
              fontSize: 12, fontWeight: 700, cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' as const,
            }}>
              Upgrade
            </button>
          </div>
        )}

        {!setupComplete && (
          <div onClick={() => onNavigate?.('complete-store')} style={{ display: 'flex', alignItems: 'center', gap: 10, background: C.white, borderRadius: 14, padding: '12px 14px', marginBottom: 16, cursor: 'pointer', boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.greenLight }}>
              <Rocket size={16} color={C.green} />
            </div>
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: C.dark }}>{user?.sellingMode === 'in-person' ? "You're set up! A few more details" : 'Your store is live! Finish setting it up'}</p>
              <p style={{ fontSize: 12, color: C.gray }}>{setupItemsDone}/5 steps completed - tap to continue</p>
            </div>
            <ChevronRight size={18} color={C.gray} />
          </div>
        )}

        <div style={{ background: C.white, borderRadius: 16, padding: '14px 16px', marginBottom: 16, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <p style={{ color: C.gray, fontSize: 12, marginBottom: 4 }}>Total Revenue</p>
              <h1 style={{ color: C.dark, fontSize: 28, fontWeight: 800, marginBottom: 4 }}>{NAIRA}{periodRevenue.toLocaleString()}</h1>
              <p style={{ color: C.gray, fontSize: 11.5 }}>{filter === 'Today' ? "Today's sales" : filter === 'This Week' ? 'Last 7 days' : 'This calendar month'}</p>
            </div>
            <select value={filter} onChange={e => setFilter(e.target.value)} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: '6px 10px', color: C.dark, fontSize: 12, cursor: 'pointer', outline: 'none' }}>
              <option>Today</option>
              <option>This Week</option>
              <option>This Month</option>
            </select>
          </div>
        </div>

        {/* Quick Actions */}
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: C.dark, marginBottom: 12 }}>Quick Actions</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            {[
              { label: 'Add Product', Icon: ShoppingBag, bg: C.blueLight, color: C.blue, action: 'products' },
              { label: 'Share Store', Icon: Share2, bg: C.greenLight, color: C.green, action: 'share-store' },
              { label: 'Create Coupon', Icon: Tag, bg: C.purpleLight, color: C.purple, action: 'coupons' },
              { label: 'Manage Orders', Icon: Package, bg: C.orangeLight, color: C.orange, action: 'orders' },
            ].map(item => (
              <button key={item.label} onClick={() => onNavigate?.(item.action)} style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 14, padding: '14px 4px', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 8, cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
                <div style={{ width: 40, height: 40, borderRadius: 12, background: item.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <item.Icon size={18} color={item.color} />
                </div>
                <span style={{ fontSize: 10.5, fontWeight: 600, color: C.dark, textAlign: 'center' as const, lineHeight: 1.2 }}>{item.label}</span>
              </button>
            ))}
          </div>
        </div>

        {lowStockCount > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: C.orangeLight, borderRadius: 14, padding: '12px 14px', marginBottom: 16 }}>
            <AlertTriangle size={18} color={C.orange} />
            <p style={{ fontSize: 13, color: C.dark, fontWeight: 600, flex: 1 }}>
              {lowStockCount} product{lowStockCount > 1 ? 's' : ''} running low or out of stock
            </p>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
          {[
            { label: 'Orders', value: String(recentOrders.length), sub: 'Total', growth: null, bgIcon: C.blueLight, iconColor: C.blue, Icon: ShoppingBag },
            { label: 'Profit', value: `${NAIRA}${(estimatedProfit / 1000).toFixed(0)}K`, sub: filter === 'Today' ? 'Today' : filter === 'This Week' ? 'This week' : 'This month', growth: null, bgIcon: C.greenLight, iconColor: C.green, Icon: Wallet },
            { label: 'Products', value: String(products.length), sub: 'Active', growth: null, bgIcon: C.purpleLight, iconColor: C.purple, Icon: Package },
            { label: 'Customers', value: String(totalCustomers), sub: 'Total', growth: null, bgIcon: C.orangeLight, iconColor: C.orange, Icon: Users },
          ].map(card => (
            <div key={card.label} style={{ background: C.white, borderRadius: 12, padding: '11px 11px 9px', boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ width: 26, height: 26, background: card.bgIcon, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <card.Icon size={13} color={card.iconColor} />
                </div>
                {card.growth && <span style={{ background: C.greenLight, color: C.green, fontSize: 9.5, fontWeight: 700, padding: '2px 6px', borderRadius: 20, display: 'flex', alignItems: 'center', gap: 2 }}><TrendingUp size={9} /> {card.growth}</span>}
              </div>
              <p style={{ fontSize: 11, color: C.gray, marginBottom: 2 }}>{card.label}</p>
              <p style={{ fontSize: 17, fontWeight: 700, color: C.dark, marginBottom: 1 }}>{card.value}</p>
              <p style={{ fontSize: 10, color: C.gray }}>{card.sub}</p>
            </div>
          ))}
        </div>

        <DashboardInfoCarousel onSelect={setActiveInfoCard} />
      </div>
    </div>
  );
}

function OrdersScreen() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState('All');
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const filters = ['All', 'Pending', 'Processing', 'Completed', 'Cancelled'];

  useEffect(() => {
    if (!user?.uid) return;
    const unsub = onSnapshot(collection(db, 'merchants', user.uid, 'orders'), (snap) => {
      const list: Order[] = snap.docs
        .map(d => ({ id: d.id, ...(d.data() as any) }))
        .sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      setOrders(list);
      setOrdersLoading(false);
      setSelectedOrder(prev => prev ? list.find(o => o.id === prev.id) || null : null);
    }, () => setOrdersLoading(false));
    return unsub;
  }, [user?.uid]);

  const filteredOrders = orders.filter(o => activeFilter === 'All' || o.status === activeFilter);

  const updateOrderStatus = async (newStatus: Order['status']) => {
    if (!user?.uid || !selectedOrder) return;
    setUpdatingStatus(true);
    try {
      await setDoc(doc(db, 'merchants', user.uid, 'orders', selectedOrder.id), { status: newStatus }, { merge: true });
      const updatedOrder = { ...selectedOrder, status: newStatus };
      sendStoreEmail(updatedOrder.customerEmail, `Order Update - ${user.storeName || 'Your Order'}`, buildStatusUpdateEmail(updatedOrder, user.storeName || 'Our Store'));
    } catch (err) {
      console.error('Could not update order status:', err);
    } finally {
      setUpdatingStatus(false);
    }
  };

  if (selectedOrder) {
    return (
      <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
        <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 32px', display: 'flex', alignItems: 'center', gap: 14 }}>
          <button onClick={() => setSelectedOrder(null)} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <ArrowLeft size={18} color="white" />
          </button>
          <div>
            <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>{selectedOrder.customerName}</h2>
            <p style={{ color: 'rgba(255,255,255,0.65)', fontSize: 12 }}>Ref: {selectedOrder.reference}</p>
          </div>
        </div>
        <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <span style={{ background: statusConfig[selectedOrder.status]?.bg, color: statusConfig[selectedOrder.status]?.color, fontSize: 12, fontWeight: 700, padding: '5px 14px', borderRadius: 20 }}>{selectedOrder.status}</span>
            <p style={{ fontSize: 20, fontWeight: 800, color: C.dark }}>{NAIRA}{selectedOrder.total.toLocaleString()}</p>
          </div>

          {selectedOrder.paymentMethod === 'Paystack' && selectedOrder.status === 'Processing' && (
            <div style={{ background: C.blueLight, borderRadius: 12, padding: 14, marginBottom: 20 }}>
              <p style={{ fontSize: 12.5, color: C.blue, lineHeight: 1.5 }}>
                This customer completed a Paystack payment. Double check it landed in your Paystack dashboard, then mark this order Completed once you've confirmed and started fulfilling it.
              </p>
            </div>
          )}

          <p style={{ fontSize: 13, fontWeight: 700, color: C.dark, marginBottom: 10 }}>Update status</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const, marginBottom: 24 }}>
            {(['Pending', 'Processing', 'Completed', 'Cancelled'] as Order['status'][]).filter(s => s !== selectedOrder.status).map(s => (
              <button key={s} disabled={updatingStatus} onClick={() => updateOrderStatus(s)} style={{ background: statusConfig[s]?.bg, color: statusConfig[s]?.color, border: 'none', borderRadius: 10, padding: '9px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', opacity: updatingStatus ? 0.6 : 1 }}>
                Mark as {s}
              </button>
            ))}
          </div>

          <p style={{ fontSize: 13, fontWeight: 700, color: C.dark, marginBottom: 10 }}>Items</p>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden', marginBottom: 20 }}>
            {selectedOrder.items?.map((item, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 14px', borderBottom: i < selectedOrder.items.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                <div>
                  <p style={{ fontSize: 13.5, fontWeight: 600, color: C.dark }}>{item.name} x{item.quantity}</p>
                  {item.options && Object.keys(item.options).length > 0 && (
                    <p style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>{Object.values(item.options).join(', ')}</p>
                  )}
                </div>
                <p style={{ fontSize: 13.5, fontWeight: 700, color: C.dark }}>{NAIRA}{(item.price * item.quantity).toLocaleString()}</p>
              </div>
            ))}
          </div>

          <div style={{ background: C.bg, borderRadius: 12, padding: 14, marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 12.5, color: C.gray }}>Subtotal</span>
              <span style={{ fontSize: 12.5, color: C.dark, fontWeight: 600 }}>{NAIRA}{selectedOrder.subtotal.toLocaleString()}</span>
            </div>
            {selectedOrder.discount > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12.5, color: C.green }}>Discount {selectedOrder.couponCode ? `(${selectedOrder.couponCode})` : ''}</span>
                <span style={{ fontSize: 12.5, color: C.green, fontWeight: 600 }}>-{NAIRA}{selectedOrder.discount.toLocaleString()}</span>
              </div>
            )}
            {selectedOrder.shippingFee > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 12.5, color: C.gray }}>Delivery</span>
                <span style={{ fontSize: 12.5, color: C.dark, fontWeight: 600 }}>{NAIRA}{selectedOrder.shippingFee.toLocaleString()}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 13.5, color: C.dark, fontWeight: 800 }}>Total</span>
              <span style={{ fontSize: 13.5, color: C.dark, fontWeight: 800 }}>{NAIRA}{selectedOrder.total.toLocaleString()}</span>
            </div>
          </div>

          {selectedOrder.paymentMethod === 'Bank Transfer' && selectedOrder.status === 'Pending' && (
            <div style={{ background: C.orangeLight, borderRadius: 12, padding: 14, marginBottom: 20 }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: C.orange, marginBottom: 6 }}>Awaiting your confirmation</p>
              <p style={{ fontSize: 12.5, color: C.dark, lineHeight: 1.5 }}>
                The customer says they've sent {NAIRA}{selectedOrder.total.toLocaleString()} directly
                to your bank account. Check your bank alert, and once you've confirmed it arrived,
                update this order's status below.
              </p>
            </div>
          )}

          {selectedOrder.deliveryAddress && (
            <div style={{ background: C.blueLight, borderRadius: 12, padding: 14, marginBottom: 20 }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: C.blue, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}><MapPin size={14} /> Deliver to</p>
              <p style={{ fontSize: 13.5, color: C.dark, fontWeight: 600, lineHeight: 1.5 }}>{selectedOrder.deliveryAddress}</p>
              <p style={{ fontSize: 13, color: C.dark, marginTop: 2 }}>{selectedOrder.deliveryCity}, {selectedOrder.deliveryState}</p>
              {selectedOrder.courierName && (
                <p style={{ fontSize: 13, color: C.blue, fontWeight: 700, marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Truck size={14} /> Customer chose: {selectedOrder.courierName}
                </p>
              )}
            </div>
          )}

          {selectedOrder.customFields && selectedOrder.customFields.length > 0 && (
            <div style={{ background: C.bg, borderRadius: 12, padding: 14, marginBottom: 20 }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: C.dark, marginBottom: 8 }}>Customer's answers</p>
              {selectedOrder.customFields.map((f, i) => (
                <div key={i} style={{ marginBottom: i < selectedOrder.customFields!.length - 1 ? 8 : 0 }}>
                  <p style={{ fontSize: 11.5, color: C.gray }}>{f.label}</p>
                  <p style={{ fontSize: 13, color: C.dark, fontWeight: 600 }}>{f.value}</p>
                </div>
              ))}
            </div>
          )}

          {selectedOrder.termsAccepted && (
            <div style={{ background: C.greenLight, borderRadius: 12, padding: 14, marginBottom: 20 }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: C.green, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={14} /> Terms & Conditions accepted
              </p>
              <p style={{ fontSize: 11.5, color: C.dark, marginBottom: 6 }}>
                {selectedOrder.termsAcceptedAt ? new Date(selectedOrder.termsAcceptedAt).toLocaleString() : ''}
              </p>
              {selectedOrder.termsAcceptedText && (
                <p style={{ fontSize: 12, color: C.gray, lineHeight: 1.5, fontStyle: 'italic' as const }}>"{selectedOrder.termsAcceptedText}"</p>
              )}
            </div>
          )}

          <p style={{ fontSize: 13, fontWeight: 700, color: C.dark, marginBottom: 10 }}>Customer</p>
          <p style={{ fontSize: 13, color: C.dark, marginBottom: 4 }}>{selectedOrder.customerEmail}</p>
          {selectedOrder.customerPhone && (
            <a href={`https://wa.me/${selectedOrder.customerPhone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8, color: C.navy, fontSize: 13, fontWeight: 700, textDecoration: 'none' }}>
              <MessageCircle size={14} /> {selectedOrder.customerPhone}
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 32px' }}>
        <h2 style={{ color: 'white', fontSize: 22, fontWeight: 700 }}>Orders</h2>
        <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 2 }}>{orders.length} total order{orders.length !== 1 ? 's' : ''}</p>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20 }}>
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto' as const, paddingBottom: 12, marginBottom: 16 }}>
          {filters.map(f => (
            <button key={f} onClick={() => setActiveFilter(f)} style={{ background: activeFilter === f ? C.navy : C.bg, color: activeFilter === f ? 'white' : C.gray, border: 'none', borderRadius: 20, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const }}>{f}</button>
          ))}
        </div>
        {ordersLoading && (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray, fontSize: 14 }}>Loading orders...</div>
        )}
        {!ordersLoading && filteredOrders.length === 0 && (
          <div style={{ textAlign: 'center' as const, padding: '50px 0', color: C.gray }}>
            <ShoppingBag size={36} color={C.border} style={{ marginBottom: 12 }} />
            <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{orders.length === 0 ? 'No orders yet' : 'No orders with this status'}</p>
            <p style={{ fontSize: 13 }}>{orders.length === 0 ? 'Orders placed at checkout on your storefront will show up here.' : 'Try a different filter.'}</p>
          </div>
        )}
        {filteredOrders.map(order => (
          <button key={order.id} onClick={() => setSelectedOrder(order)} style={{ width: '100%', background: 'none', border: 'none', textAlign: 'left' as const, cursor: 'pointer', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '14px 0', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
              <div style={{ width: 46, height: 46, borderRadius: '50%', background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: 'white', flexShrink: 0 }}>
                {order.customerName?.[0]?.toUpperCase() || 'C'}
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: 15, fontWeight: 600, color: C.dark, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>{order.customerName || 'Customer'}</p>
                <p style={{ fontSize: 12, color: C.gray, marginBottom: 2 }}>{order.items?.length || 0} item{(order.items?.length || 0) !== 1 ? 's' : ''} - {order.paymentMethod}</p>
                <p style={{ fontSize: 11, color: C.gray }}>{order.createdAt ? new Date(order.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</p>
              </div>
            </div>
            <div style={{ textAlign: 'right' as const, flexShrink: 0, marginLeft: 12 }}>
              <p style={{ fontSize: 15, fontWeight: 700, color: C.dark, marginBottom: 6 }}>{NAIRA}{(order.total || 0).toLocaleString()}</p>
              <span style={{ background: statusConfig[order.status]?.bg, color: statusConfig[order.status]?.color, fontSize: 11, fontWeight: 700, padding: '4px 12px', borderRadius: 20 }}>{order.status}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
// A full-screen camera modal that scans a real barcode using the phone's own camera, via the
// browser's built-in BarcodeDetector API (supported on Chrome for Android - no extra library
// needed). Calls onDetected once with the scanned code, then the caller closes the modal.
// Falls back to a plain message if the browser doesn't support barcode detection at all.
function BarcodeScannerModal({ onDetected, onClose }: { onDetected: (code: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    if (!('BarcodeDetector' in window)) {
      setSupported(false);
      return;
    }
    let stream: MediaStream | null = null;
    let stopped = false;
    let rafId = 0;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        const detector = new (window as any).BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
        const scanLoop = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length > 0 && !stopped) {
              stopped = true;
              onDetected(codes[0].rawValue);
              return;
            }
          } catch (err) {
            // ignore per-frame detection errors, keep scanning
          }
          if (!stopped) rafId = requestAnimationFrame(scanLoop);
        };
        scanLoop();
      } catch (err) {
        setError('Could not access your camera. Please check camera permissions and try again.');
      }
    })();

    return () => {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (stream) stream.getTracks().forEach(t => t.stop());
    };
  }, []);

  return (
    <div style={{ position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 200, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <button onClick={onClose} style={{ position: 'absolute' as const, top: 20, right: 20, background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
        <X size={18} color="white" />
      </button>
      {!supported ? (
        <p style={{ color: 'white', fontSize: 14, textAlign: 'center' as const, maxWidth: 280, lineHeight: 1.5 }}>Barcode scanning isn't supported in this browser. Please enter the barcode manually instead.</p>
      ) : error ? (
        <p style={{ color: 'white', fontSize: 14, textAlign: 'center' as const, maxWidth: 280, lineHeight: 1.5 }}>{error}</p>
      ) : (
        <>
          <div style={{ width: '100%', maxWidth: 340, aspectRatio: '1', borderRadius: 20, overflow: 'hidden', position: 'relative' as const, border: '2px solid rgba(255,255,255,0.3)' }}>
            <video ref={videoRef} style={{ width: '100%', height: '100%', objectFit: 'cover' as const }} muted playsInline />
          </div>
          <p style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, marginTop: 18, textAlign: 'center' as const }}>Point your camera at a barcode</p>
        </>
      )}
    </div>
  );
}

function ProductForm({ product, onSave, onCancel, externalError }: { product: Product | null; onSave: (p: Product) => void; onCancel: () => void; externalError?: string }) {
  const { user } = useAuth();
  const isEdit = !!product;
  const [name, setName] = useState(product?.name || '');
  const [price, setPrice] = useState(product?.price?.toString() || '');
  const [status, setStatus] = useState<Product['status']>(product?.status || 'In stock');
  const [quantity, setQuantity] = useState(product?.quantity?.toString() || '');
  const [minOrderQty, setMinOrderQty] = useState(product?.minOrderQty?.toString() || '');
  const [maxOrderQty, setMaxOrderQty] = useState(product?.maxOrderQty?.toString() || '');
  const [priceTiers, setPriceTiers] = useState<{ minQty: string; price: string }[]>(
    product?.priceTiers?.map(t => ({ minQty: t.minQty.toString(), price: t.price.toString() })) || []
  );
  const [badge, setBadge] = useState<Product['badge']>(product?.badge || 'None');
  const [salePrice, setSalePrice] = useState(product?.salePrice?.toString() || '');
  const [emoji, setEmoji] = useState(product?.emoji || 'shirt');
  const [category, setCategory] = useState(product?.category || '');
  const [customCategoryMode, setCustomCategoryMode] = useState(() => !!product?.category && !PRODUCT_CATEGORIES.includes(product.category));
  const [description, setDescription] = useState(product?.description || '');
  const [descriptionSections, setDescriptionSections] = useState<DescriptionSection[]>(product?.descriptionSections || []);
  const [openSection, setOpenSection] = useState<number | null>(null);
  const [images, setImages] = useState<string[]>(product?.images && product.images.length > 0 ? product.images : (product?.imageUrl ? [product.imageUrl] : []));
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErrorLocal, setSaveErrorLocal] = useState('');
  const [options, setOptions] = useState<OptionGroup[]>(product?.options || []);
  const [newOptionValue, setNewOptionValue] = useState<{ [groupIndex: number]: string }>({});
  const [optionsError, setOptionsError] = useState('');
  const [shareCopied, setShareCopied] = useState(false);
  const [barcode, setBarcode] = useState(product?.barcode || '');
  const [showScanner, setShowScanner] = useState(false);

  const inp = { width: '100%', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 15, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };
  const label = { fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 };

  const shareLink = product && user?.storeSlug
    ? `${window.location.origin}/${user.storeSlug}/product/${product.id}`
    : null;

  const handleShare = async () => {
    if (!shareLink) return;
    const shareText = `Check out ${name} on my store!`;
    if (navigator.share) {
      try {
        await navigator.share({ title: name, text: shareText, url: shareLink });
      } catch (err) {
        // person cancelled the share sheet, do nothing
      }
    } else {
      copyToClipboard(shareLink);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 1500);
    }
  };

  const handleCopyLink = () => {
    if (!shareLink) return;
    copyToClipboard(shareLink);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 1500);
  };

  const MAX_PRODUCT_IMAGES = 5;

  const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0 || !user?.uid) return;

    const remainingSlots = MAX_PRODUCT_IMAGES - images.length;
    if (remainingSlots <= 0) {
      setUploadError(`You can add up to ${MAX_PRODUCT_IMAGES} photos per product.`);
      return;
    }
    const filesToUpload = files.slice(0, remainingSlots);

    for (const file of filesToUpload) {
      if (!file.type.startsWith('image/')) {
        setUploadError('Please choose image files only.');
        continue;
      }
      if (file.size > 8 * 1024 * 1024) {
        setUploadError('One or more images are too large. Please choose photos under 8MB.');
        continue;
      }
      setUploadError('');
      setUploading(true);
      try {
        const compressed = await compressImage(file, 1280, 0.75);
        const url = await uploadToCloudinary(compressed, `products/${user.uid}`);
        setImages(prev => [...prev, url]);
      } catch (err: any) {
        setUploadError(err?.message || 'Upload failed. Check your connection and try again.');
      } finally {
        setUploading(false);
      }
    }
  };

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  };

  const addOptionGroup = () => {
    if (options.length >= 2) {
      setOptionsError('You can only add up to 2 option types (for example Size and Color).');
      return;
    }
    setOptionsError('');
    setOptions([...options, { name: '', values: [] }]);
  };

  const removeOptionGroup = (groupIndex: number) => {
    setOptions(options.filter((_, i) => i !== groupIndex));
    setOptionsError('');
  };

  const updateGroupName = (groupIndex: number, name: string) => {
    setOptions(options.map((g, i) => i === groupIndex ? { ...g, name } : g));
  };

  const addOptionValue = (groupIndex: number) => {
    const value = (newOptionValue[groupIndex] || '').trim();
    if (!value) return;
    setOptions(options.map((g, i) => {
      if (i !== groupIndex) return g;
      if (g.values.some(v => v.toLowerCase() === value.toLowerCase())) return g;
      return { ...g, values: [...g.values, value] };
    }));
    setNewOptionValue({ ...newOptionValue, [groupIndex]: '' });
  };

  const removeOptionValue = (groupIndex: number, value: string) => {
    setOptions(options.map((g, i) => i === groupIndex ? { ...g, values: g.values.filter(v => v !== value) } : g));
  };

  const handleSave = async () => {
    setSaveErrorLocal('');
    if (!name.trim()) {
      setSaveErrorLocal('Please enter a product name.');
      return;
    }
    if (!price) {
      setSaveErrorLocal('Please enter a price.');
      return;
    }
    for (const group of options) {
      if (!group.name.trim()) {
        setSaveErrorLocal('Please name each option (for example "Size" or "Color").');
        return;
      }
      if (group.values.length < 2) {
        setSaveErrorLocal(`Add at least 2 choices for "${group.name}" (for example Small and Large), or remove it.`);
        return;
      }
    }
    if (minOrderQty && maxOrderQty && Number(minOrderQty) > Number(maxOrderQty)) {
      setSaveErrorLocal('Minimum order quantity cannot be more than the maximum.');
      return;
    }
    for (const tier of priceTiers) {
      if (!tier.minQty || !tier.price) {
        setSaveErrorLocal('Please fill in both fields for every price break, or remove the empty one.');
        return;
      }
    }
    setSaving(true);
    try {
      await onSave({
        id: product?.id || Date.now().toString(),
        name: name.trim(),
        price: Number(price),
        salePrice: badge === 'Sale' && salePrice ? Number(salePrice) : null,
        status,
        badge,
        emoji,
        category: category || undefined,
        minOrderQty: minOrderQty ? Number(minOrderQty) : undefined,
        maxOrderQty: maxOrderQty ? Number(maxOrderQty) : undefined,
        priceTiers: priceTiers.length > 0 ? priceTiers.map(t => ({ minQty: Number(t.minQty), price: Number(t.price) })) : undefined,
        imageUrl: images[0] || undefined,
        images: images.length > 0 ? images : undefined,
        description: description.trim() || undefined,
        descriptionSections: descriptionSections.length > 0 ? descriptionSections : undefined,
        options: options.length > 0 ? options : undefined,
        quantity: quantity !== '' ? Number(quantity) : undefined,
        barcode: barcode.trim() || undefined,
      });
    } catch (err: any) {
      setSaveErrorLocal(err?.message || 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onCancel} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700, flex: 1 }}>{isEdit ? 'Edit Product' : 'Add Product'}</h2>
        {shareLink && (
          <button onClick={handleShare} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <Share2 size={16} color="white" />
          </button>
        )}
      </div>
      {shareCopied && (
        <div style={{ position: 'fixed' as const, top: 16, left: '50%', transform: 'translateX(-50%)', background: C.dark, color: 'white', padding: '8px 16px', borderRadius: 20, fontSize: 13, fontWeight: 600, zIndex: 200 }}>
          Link copied!
        </div>
      )}

      {shareLink && (
        <div style={{ padding: '16px 20px 0', background: C.bg }}>
          <div style={{ display: 'flex', alignItems: 'center', background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: '10px 12px', gap: 10 }}>
            <span style={{ flex: 1, fontSize: 12, color: C.gray, overflow: 'hidden', textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>{shareLink}</span>
            <button onClick={handleCopyLink} style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Copy size={12} /> Copy
            </button>
          </div>
        </div>
      )}

      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <label style={{ ...label, marginBottom: 0 }}>Product photos</label>
              <span style={{ fontSize: 11, color: C.gray }}>{images.length}/{MAX_PRODUCT_IMAGES}</span>
            </div>
            <div style={{ display: 'flex', gap: 10, overflowX: 'auto' as const, paddingBottom: 4 }}>
              {images.map((img, i) => (
                <div key={i} style={{ width: 80, height: 80, borderRadius: 14, background: C.bg, position: 'relative' as const, flexShrink: 0, overflow: 'hidden' }}>
                  <img src={img} alt={`Product ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' as const }} />
                  <button onClick={() => removeImage(i)} style={{ position: 'absolute' as const, top: 4, right: 4, background: 'rgba(0,0,0,0.6)', border: 'none', borderRadius: '50%', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                    <X size={11} color="white" />
                  </button>
                  {i === 0 && (
                    <div style={{ position: 'absolute' as const, bottom: 4, left: 4, background: 'rgba(0,0,0,0.6)', color: 'white', fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 6 }}>Cover</div>
                  )}
                </div>
              ))}
              {images.length < MAX_PRODUCT_IMAGES && (
                <label style={{ width: 80, height: 80, borderRadius: 14, border: `1.5px dashed ${C.border}`, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', gap: 4, cursor: 'pointer', flexShrink: 0, position: 'relative' as const }}>
                  {uploading ? (
                    <div style={{ width: 20, height: 20, border: `2.5px solid ${C.border}`, borderTopColor: C.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                  ) : (
                    <>
                      <Camera size={18} color={C.gray} />
                      <span style={{ fontSize: 10, color: C.gray, fontWeight: 600 }}>Add photo</span>
                    </>
                  )}
                  <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handlePhotoSelect} disabled={uploading} />
                </label>
              )}
              {images.length === 0 && !uploading && (
                <div style={{ width: 80, height: 80, borderRadius: 14, background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <ProductIcon iconKey={emoji} size={32} color={C.gray} />
                </div>
              )}
            </div>
            <p style={{ fontSize: 11, color: C.gray, marginTop: 8 }}>
              The first photo is the cover image customers see first. Add up to {MAX_PRODUCT_IMAGES} so customers can scroll through different angles.
            </p>
            {uploadError && <p style={{ color: '#EF4444', fontSize: 12, marginTop: 8 }}>{uploadError}</p>}
            {images.length === 0 && (
              <div style={{ display: 'flex', gap: 8, overflowX: 'auto' as const, paddingTop: 12 }}>
                {PRODUCT_ICON_KEYS.map(key => (
                  <button key={key} onClick={() => setEmoji(key)} style={{ minWidth: 44, height: 44, borderRadius: 10, border: `2px solid ${emoji === key ? C.navy : C.border}`, background: emoji === key ? C.bg : C.white, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <ProductIcon iconKey={key} size={18} color={emoji === key ? C.navy : C.gray} />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label style={label}>Product name</label>
            <input style={inp} placeholder="e.g. Classic Senator Wear" value={name} onChange={e => setName(e.target.value)} />
          </div>

          <div>
            <label style={label}>Barcode <span style={{ color: C.gray, fontWeight: 400 }}>(optional)</span></label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={{ ...inp, flex: 1 }} placeholder="Scan or type a barcode" value={barcode} onChange={e => setBarcode(e.target.value)} />
              <button onClick={() => setShowScanner(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: C.navy, border: 'none', borderRadius: 12, padding: '0 16px', color: 'white', fontSize: 13, fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}>
                <Camera size={15} /> Scan
              </button>
            </div>
            {showScanner && (
              <BarcodeScannerModal
                onDetected={(code) => { setBarcode(code); setShowScanner(false); }}
                onClose={() => setShowScanner(false)}
              />
            )}
          </div>

          <div>
            <label style={label}>Category</label>
            {customCategoryMode ? (
              <div>
                <input
                  style={inp}
                  placeholder="e.g. Tops, Pants, Chargers..."
                  value={category}
                  onChange={e => setCategory(e.target.value)}
                  autoFocus
                />
                <button
                  onClick={() => { setCustomCategoryMode(false); setCategory(''); }}
                  style={{ background: 'none', border: 'none', color: C.navy, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', padding: '8px 0 0' }}
                >
                  â† Choose from preset categories instead
                </button>
              </div>
            ) : (
              <>
                <select
                  style={{ ...inp, appearance: 'none' } as any}
                  value={category}
                  onChange={e => {
                    if (e.target.value === '__custom__') { setCustomCategoryMode(true); setCategory(''); }
                    else setCategory(e.target.value);
                  }}
                >
                  <option value="">Select a category</option>
                  {PRODUCT_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  <option value="__custom__">+ Create my own category...</option>
                </select>
                <p style={{ fontSize: 11.5, color: C.gray, marginTop: 6 }}>Want something more specific, like "Tops" or "Pants"? Choose "Create my own category" above.</p>
              </>
            )}
          </div>

          <div>
            <label style={label}>Description <span style={{ color: C.gray, fontWeight: 400 }}>(optional)</span></label>

            {descriptionSections.length > 0 ? (
              <div>
                <div style={{ border: `1.5px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
                  {descriptionSections.map((section, i) => (
                    <div key={i} style={{ borderBottom: i < descriptionSections.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                      <button
                        onClick={() => setOpenSection(openSection === i ? null : i)}
                        style={{ width: '100%', background: C.white, border: 'none', padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', textAlign: 'left' as const }}
                      >
                        <span style={{ fontSize: 14, fontWeight: 600, color: C.dark, display: 'flex', alignItems: 'center', gap: 8 }}><CheckCircle2 size={15} color={C.green} /> {section.title}</span>
                        <span style={{ color: C.gray, display: 'flex', transform: openSection === i ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}><ChevronDown size={14} /></span>
                      </button>
                      {openSection === i && (
                        <div style={{ padding: '0 16px 14px' }}>
                          <p style={{ fontSize: 13, color: C.gray, lineHeight: 1.5 }}>{section.text}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => { setDescriptionSections([]); setOpenSection(null); }}
                  style={{ background: 'transparent', border: 'none', color: C.gray, fontSize: 12, fontWeight: 600, cursor: 'pointer', marginTop: 8, textDecoration: 'underline' }}
                >
                  Clear and write my own instead
                </button>
              </div>
            ) : (
              <textarea
                style={{ ...inp, resize: 'vertical' as const, minHeight: 110, fontFamily: 'inherit' }}
                placeholder="Tell customers what makes this product great..."
                value={description}
                onChange={e => setDescription(e.target.value)}
                maxLength={800}
              />
            )}
            {descriptionSections.length === 0 && (
              <p style={{ fontSize: 11, color: C.gray, marginTop: 4, textAlign: 'right' as const }}>{description.length}/800</p>
            )}
          </div>

          <div>
            <label style={label}>Price ({NAIRA})</label>
            <input style={inp} type="number" placeholder="e.g. 39000" value={price} onChange={e => setPrice(e.target.value)} />
          </div>

          <div>
            <label style={label}>Quantity in stock <span style={{ color: C.gray, fontWeight: 400 }}>(optional)</span></label>
            <input
              style={inp}
              type="number"
              placeholder="e.g. 1000"
              value={quantity}
              onChange={e => {
                const v = e.target.value;
                setQuantity(v);
                const n = Number(v);
                if (v === '') return;
                if (n <= 0) setStatus('Out of stock');
                else if (n <= 5) setStatus('Low stock');
                else setStatus('In stock');
              }}
            />
            <p style={{ fontSize: 11, color: C.gray, marginTop: 6 }}>
              Track how many units you have. As you sell, update this number and the stock label below will adjust - you can also set it manually.
            </p>
          </div>

          <div>
            <label style={label}>Order limits (optional)</label>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <input style={inp} type="number" placeholder="Min qty" value={minOrderQty} onChange={e => setMinOrderQty(e.target.value)} />
              </div>
              <div style={{ flex: 1 }}>
                <input style={inp} type="number" placeholder="Max qty" value={maxOrderQty} onChange={e => setMaxOrderQty(e.target.value)} />
              </div>
            </div>
            <p style={{ fontSize: 11, color: C.gray, marginTop: 6 }}>
              Set a minimum if you only sell in bulk (e.g. must buy at least 5), or a maximum to stop one customer buying too much at once. Leave blank for no limit.
            </p>
          </div>

          <div>
            <label style={label}>Wholesale pricing (optional)</label>
            <p style={{ fontSize: 11, color: C.gray, marginBottom: 10 }}>
              Give a lower price per unit when a customer buys more. E.g. buy 5+ for {NAIRA}1,800 each instead of the normal price.
            </p>
            {priceTiers.map((tier, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <input style={inp} type="number" placeholder="Buy this many+" value={tier.minQty} onChange={e => setPriceTiers(priceTiers.map((t, j) => j === i ? { ...t, minQty: e.target.value } : t))} />
                </div>
                <div style={{ flex: 1 }}>
                  <input style={inp} type="number" placeholder="Price each" value={tier.price} onChange={e => setPriceTiers(priceTiers.map((t, j) => j === i ? { ...t, price: e.target.value } : t))} />
                </div>
                <button onClick={() => setPriceTiers(priceTiers.filter((_, j) => j !== i))} style={{ background: '#FEE2E2', border: 'none', borderRadius: 8, width: 36, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}><Trash2 size={14} color="#EF4444" /></button>
              </div>
            ))}
            <button onClick={() => setPriceTiers([...priceTiers, { minQty: '', price: '' }])} style={{ background: C.bg, border: `1px dashed ${C.border}`, borderRadius: 10, padding: '10px 14px', fontSize: 12.5, fontWeight: 700, color: C.dark, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Plus size={14} /> Add price break
            </button>
          </div>

          <div>
            <label style={label}>Stock status</label>
            <select style={{ ...inp, appearance: 'none' } as any} value={status} onChange={e => setStatus(e.target.value as Product['status'])}>
              <option value="In stock">In stock</option>
              <option value="Low stock">Low stock</option>
              <option value="Out of stock">Out of stock</option>
            </select>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={{ ...label, marginBottom: 0 }}>Options <span style={{ color: C.gray, fontWeight: 400 }}>(optional)</span></label>
              {options.length < 2 && (
                <button onClick={addOptionGroup} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: `1.5px solid ${C.navy}`, borderRadius: 20, padding: '6px 12px', fontSize: 12, fontWeight: 700, color: C.navy, cursor: 'pointer' }}>
                  <Plus size={12} /> Add option
                </button>
              )}
            </div>
            <p style={{ fontSize: 12, color: C.gray, marginBottom: 12 }}>Let customers pick things like size or color. Same price for every choice.</p>

            {options.length === 0 && (
              <p style={{ fontSize: 13, color: C.gray, fontStyle: 'italic' as const }}>No options added. This product will be sold as-is.</p>
            )}

            {options.map((group, gi) => (
              <div key={gi} style={{ border: `1.5px solid ${C.border}`, borderRadius: 12, padding: 14, marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <input
                    style={{ ...inp, padding: '10px 12px', fontSize: 14, flex: 1 }}
                    placeholder='Option name, e.g. "Size" or "Color"'
                    value={group.name}
                    onChange={e => updateGroupName(gi, e.target.value)}
                  />
                  <button onClick={() => removeOptionGroup(gi)} style={{ background: '#FEE2E2', border: 'none', borderRadius: 8, width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
                    <Trash2 size={14} color="#EF4444" />
                  </button>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6, marginBottom: 10 }}>
                  {group.values.map(v => {
                    const showSwatch = isColorOptionGroup(group.name) && isValidCSSColor(v);
                    return (
                      <span key={v} style={{ display: 'flex', alignItems: 'center', gap: 6, background: C.bg, borderRadius: 20, padding: '6px 6px 6px 12px', fontSize: 13, color: C.dark, fontWeight: 600 }}>
                        {showSwatch && <span style={{ width: 16, height: 16, borderRadius: '50%', background: v, border: `1px solid ${C.border}`, flexShrink: 0 }} />}
                        {v}
                        <button onClick={() => removeOptionValue(gi, v)} style={{ background: 'none', border: 'none', color: C.gray, cursor: 'pointer', padding: 0, lineHeight: 1, width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={12} /></button>
                      </span>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    style={{ ...inp, padding: '10px 12px', fontSize: 14, flex: 1 }}
                    placeholder="Type a choice and press Add, e.g. Small"
                    value={newOptionValue[gi] || ''}
                    onChange={e => setNewOptionValue({ ...newOptionValue, [gi]: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addOptionValue(gi); } }}
                  />
                  <button onClick={() => addOptionValue(gi)} style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 10, padding: '0 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Add</button>
                </div>
                {group.values.length < 2 && (
                  <p style={{ fontSize: 11, color: C.orange, marginTop: 8 }}>Add at least 2 choices for this option.</p>
                )}
              </div>
            ))}
            {optionsError && <p style={{ color: '#EF4444', fontSize: 12, marginTop: 4 }}>{optionsError}</p>}
          </div>

          <div>
            <label style={label}>Badge</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['None', 'New', 'Hot', 'Sale'] as const).map(b => (
                <button key={b} onClick={() => setBadge(b)} style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: `1.5px solid ${badge === b ? C.navy : C.border}`, background: badge === b ? C.navy : C.white, color: badge === b ? 'white' : C.gray, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>{b}</button>
              ))}
            </div>
          </div>

          {badge === 'Sale' && (
            <div>
              <label style={label}>Sale price ({NAIRA})</label>
              <input style={inp} type="number" placeholder="e.g. 27000" value={salePrice} onChange={e => setSalePrice(e.target.value)} />
            </div>
          )}

          {(saveErrorLocal || externalError) && (
            <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{saveErrorLocal || externalError}</div>
          )}

          <button disabled={saving || uploading} onClick={handleSave} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', marginTop: 8, opacity: saving || uploading ? 0.7 : 1 }}>
            {saving ? 'Saving...' : isEdit ? 'Save changes' : 'Add product'}
          </button>
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function ProductsScreen() {
  const { user } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [view, setView] = useState<'list' | 'add' | 'edit'>('list');
  const [editing, setEditing] = useState<Product | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!user?.uid) return;
    const unsub = onSnapshot(
      collection(db, 'merchants', user.uid, 'products'),
      (snap) => {
        const list: Product[] = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .filter((p: any) => !p._deleted);
        setProducts(list);
        setLoadingProducts(false);
        setLoadError('');
      },
      () => {
        setLoadingProducts(false);
        setLoadError('Could not load products. Check your connection and pull to refresh.');
      }
    );
    return unsub;
  }, [user?.uid]);

  const filtered = products.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
  const [saveError, setSaveError] = useState('');

  const handleSave = async (p: Product) => {
    if (!user?.uid) {
      setSaveError('You are not signed in. Please log in again.');
      return;
    }
    setSaveError('');
    try {
      const { id, ...rest } = p;
      const data: any = {};
      Object.keys(rest).forEach(key => {
        const value = (rest as any)[key];
        if (value !== undefined) data[key] = value;
      });
      await setDoc(doc(db, 'merchants', user.uid, 'products', id), data);
      setView('list');
      setEditing(null);
    } catch (err: any) {
      setSaveError(err?.message || 'Could not save product. Check your connection and try again.');
    }
  };

  const handleDelete = async (id: string) => {
    if (!user?.uid) return;
    try {
      await setDoc(doc(db, 'merchants', user.uid, 'products', id), { _deleted: true }, { merge: true });
      setView('list');
      setEditing(null);
    } catch (err: any) {
      setSaveError(err?.message || 'Could not delete product. Check your connection and try again.');
    }
  };

  if (view === 'add') {
    return <ProductForm product={null} onSave={handleSave} onCancel={() => setView('list')} externalError={saveError} />;
  }
  if (view === 'edit' && editing) {
    return (
      <div>
        <ProductForm product={editing} onSave={handleSave} onCancel={() => { setView('list'); setEditing(null); }} externalError={saveError} />
        <div style={{ position: 'fixed' as const, bottom: 24, left: 20, right: 20 }}>
          <button onClick={() => handleDelete(editing.id)} style={{ width: '100%', background: '#FEE2E2', color: '#EF4444', border: 'none', borderRadius: 14, padding: 14, fontSize: 15, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Trash2 size={16} /> Delete product
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 32px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ color: 'white', fontSize: 22, fontWeight: 700 }}>Products</h2>
        <button onClick={() => setView('add')} style={{ background: C.green, border: 'none', borderRadius: 12, width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <Plus size={20} color="white" />
        </button>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: C.bg, borderRadius: 12, padding: '12px 16px', marginBottom: 20 }}>
          <Search size={16} color={C.gray} />
          <input style={{ background: 'transparent', border: 'none', outline: 'none', fontSize: 14, color: C.dark, flex: 1 }} placeholder="Search products..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        {loadError && (
          <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const, marginBottom: 16 }}>{loadError}</div>
        )}

        {loadingProducts && !loadError && (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray, fontSize: 14 }}>Loading products...</div>
        )}

        {!loadingProducts && filtered.length === 0 && !loadError && (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray, fontSize: 14 }}>
            {products.length === 0 ? 'No products yet. Tap + to add your first product.' : 'No products match your search.'}
          </div>
        )}

        {filtered.map(product => (
          <div key={product.id} onClick={() => { setEditing(product); setView('edit'); }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 58, height: 58, background: C.bg, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' as const, overflow: 'hidden' }}>
                {product.imageUrl ? <img src={product.imageUrl} alt={product.name} style={{ width: '100%', height: '100%', objectFit: 'cover' as const }} /> : <ProductIcon iconKey={product.emoji} size={26} color={C.gray} />}
                {badgeConfig[product.badge] && (
                  <div style={{ position: 'absolute' as const, top: -6, left: -6, background: badgeConfig[product.badge].bg, color: badgeConfig[product.badge].color, fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 20 }}>{product.badge}</div>
                )}
              </div>
              <div>
                <p style={{ fontSize: 15, fontWeight: 600, color: C.dark, marginBottom: 4 }}>{product.name}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  {product.salePrice ? (
                    <>
                      <span style={{ fontSize: 14, fontWeight: 700, color: C.orange }}>{NAIRA}{product.salePrice.toLocaleString()}</span>
                      <span style={{ fontSize: 12, color: C.gray, textDecoration: 'line-through' }}>{NAIRA}{product.price.toLocaleString()}</span>
                    </>
                  ) : (
                    <span style={{ fontSize: 14, fontWeight: 700, color: C.navy }}>{NAIRA}{product.price.toLocaleString()}</span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const }}>
                  <span style={{ background: stockConfig[product.status]?.bg, color: stockConfig[product.status]?.color, fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>{product.status}</span>
                  {product.category && (
                    <span style={{ background: C.blueLight, color: C.blue, fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>{product.category}</span>
                  )}
                  {typeof product.quantity === 'number' && (
                    <span style={{ background: C.bg, color: C.gray, fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>{product.quantity} left</span>
                  )}
                  {product.options && product.options.length > 0 && (
                    <span style={{ background: C.purpleLight, color: C.purple, fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>{product.options.map(o => o.name).join(' / ')}</span>
                  )}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {user?.storeSlug && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const link = `${window.location.origin}/${user.storeSlug}/product/${product.id}`;
                    copyToClipboard(link);
                    if (navigator.share) {
                      navigator.share({ title: product.name, text: `Check out ${product.name} on my store!`, url: link }).catch(() => {});
                    }
                  }}
                  style={{ background: C.bg, border: 'none', borderRadius: 8, width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
                >
                  <Share2 size={14} color={C.gray} />
                </button>
              )}
              <ChevronRight size={18} color={C.gray} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CouponForm({ coupon, onSave, onCancel }: { coupon: Coupon | null; onSave: (c: Coupon) => Promise<void>; onCancel: () => void }) {
  const isEdit = !!coupon;
  const [code, setCode] = useState(coupon?.code || '');
  const [type, setType] = useState<Coupon['type']>(coupon?.type || 'percent');
  const [value, setValue] = useState(coupon?.value?.toString() || '');
  const [usageLimit, setUsageLimit] = useState(coupon?.usageLimit?.toString() || '');
  const [startDate, setStartDate] = useState(coupon?.startDate || '');
  const [endDate, setEndDate] = useState(coupon?.endDate || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const inp = { width: '100%', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 15, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };
  const label = { fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 };

  const handleSave = async () => {
    setError('');
    const cleanCode = code.trim().toUpperCase().replace(/\s+/g, '');
    if (!cleanCode) {
      setError('Please enter a coupon code.');
      return;
    }
    if (!value || Number(value) <= 0) {
      setError('Please enter a valid discount amount.');
      return;
    }
    if (type === 'percent' && Number(value) > 100) {
      setError('Percentage discount cannot be more than 100.');
      return;
    }
    setSaving(true);
    try {
      await onSave({
        id: coupon?.id || Date.now().toString(),
        code: cleanCode,
        type,
        value: Number(value),
        usageLimit: usageLimit ? Number(usageLimit) : null,
        usedCount: coupon?.usedCount || 0,
        active: coupon?.active ?? true,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        createdAt: coupon?.createdAt || new Date().toISOString(),
      });
    } catch (err: any) {
      setError(err?.message || 'Could not save coupon. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onCancel} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>{isEdit ? 'Edit Coupon' : 'New Coupon'}</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
          <div>
            <label style={label}>Coupon code</label>
            <input style={{ ...inp, textTransform: 'uppercase' as const, fontWeight: 700, letterSpacing: 1 }} placeholder="e.g. SAVE10" value={code} onChange={e => setCode(e.target.value)} maxLength={20} />
          </div>

          <div>
            <label style={label}>Discount type</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setType('percent')} style={{ flex: 1, padding: '12px 0', borderRadius: 10, border: `1.5px solid ${type === 'percent' ? C.navy : C.border}`, background: type === 'percent' ? C.navy : C.white, color: type === 'percent' ? 'white' : C.gray, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Percentage (%)</button>
              <button onClick={() => setType('fixed')} style={{ flex: 1, padding: '12px 0', borderRadius: 10, border: `1.5px solid ${type === 'fixed' ? C.navy : C.border}`, background: type === 'fixed' ? C.navy : C.white, color: type === 'fixed' ? 'white' : C.gray, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Fixed ({NAIRA})</button>
            </div>
          </div>

          <div>
            <label style={label}>{type === 'percent' ? 'Discount percentage' : `Discount amount (${NAIRA})`}</label>
            <input style={inp} type="number" placeholder={type === 'percent' ? 'e.g. 10' : 'e.g. 2000'} value={value} onChange={e => setValue(e.target.value)} />
          </div>

          <div>
            <label style={label}>Usage limit <span style={{ color: C.gray, fontWeight: 400 }}>(optional)</span></label>
            <input style={inp} type="number" placeholder="Leave blank for unlimited use" value={usageLimit} onChange={e => setUsageLimit(e.target.value)} />
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={label}>Start date <span style={{ color: C.gray, fontWeight: 400 }}>(optional)</span></label>
              <input style={inp} type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>End date <span style={{ color: C.gray, fontWeight: 400 }}>(optional)</span></label>
              <input style={inp} type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>

          {error && (
            <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>
          )}

          <button disabled={saving} onClick={handleSave} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', marginTop: 8, opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving...' : isEdit ? 'Save changes' : 'Create coupon'}
          </button>
        </div>
      </div>
    </div>
  );
}
function CouponsScreen({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [view, setView] = useState<'list' | 'add' | 'edit'>('list');
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [actionError, setActionError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.uid) return;
    const unsub = onSnapshot(
      collection(db, 'merchants', user.uid, 'coupons'),
      (snap) => {
        const list: Coupon[] = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .filter((c: any) => !c._deleted)
          .sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        setCoupons(list);
        setLoading(false);
        setLoadError('');
      },
      () => {
        setLoading(false);
        setLoadError('Could not load coupons. Check your connection and try again.');
      }
    );
    return unsub;
  }, [user?.uid]);

  const handleSave = async (c: Coupon) => {
    if (!user?.uid) {
      setActionError('You are not signed in. Please log in again.');
      return;
    }
    const duplicate = coupons.find(x => x.code === c.code && x.id !== c.id);
    if (duplicate) {
      throw new Error('You already have a coupon with this code.');
    }
    const { id, ...data } = c;
    await setDoc(doc(db, 'merchants', user.uid, 'coupons', id), data);
    setView('list');
    setEditing(null);
  };

  const handleToggleActive = async (c: Coupon) => {
    if (!user?.uid) return;
    setActionError('');
    try {
      await setDoc(doc(db, 'merchants', user.uid, 'coupons', c.id), { active: !c.active }, { merge: true });
    } catch (err: any) {
      setActionError(err?.message || 'Could not update coupon.');
    }
  };

  const handleDelete = async (id: string) => {
    if (!user?.uid) return;
    setActionError('');
    try {
      await setDoc(doc(db, 'merchants', user.uid, 'coupons', id), { _deleted: true }, { merge: true });
      setView('list');
      setEditing(null);
    } catch (err: any) {
      setActionError(err?.message || 'Could not delete coupon.');
    }
  };

  const handleCopy = (code: string, id: string) => {
    copyToClipboard(code);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  if (view === 'add') {
    return <CouponForm coupon={null} onSave={handleSave} onCancel={() => setView('list')} />;
  }
  if (view === 'edit' && editing) {
    return (
      <div>
        <CouponForm coupon={editing} onSave={handleSave} onCancel={() => { setView('list'); setEditing(null); }} />
        <div style={{ position: 'fixed' as const, bottom: 24, left: 20, right: 20 }}>
          <button onClick={() => handleDelete(editing.id)} style={{ width: '100%', background: '#FEE2E2', color: '#EF4444', border: 'none', borderRadius: 14, padding: 14, fontSize: 15, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Trash2 size={16} /> Delete coupon
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 32px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 22, fontWeight: 700, flex: 1 }}>Coupons</h2>
        <button onClick={() => setView('add')} style={{ background: C.green, border: 'none', borderRadius: 12, width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <Plus size={20} color="white" />
        </button>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20 }}>
        {actionError && (
          <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const, marginBottom: 16 }}>{actionError}</div>
        )}
        {loadError && (
          <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const, marginBottom: 16 }}>{loadError}</div>
        )}
        {loading && !loadError && (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray, fontSize: 14 }}>Loading coupons...</div>
        )}
        {!loading && coupons.length === 0 && !loadError && (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray, fontSize: 14 }}>
            <Tag size={32} color={C.border} style={{ marginBottom: 12 }} />
            <p>No coupons yet. Tap + to create your first discount code.</p>
          </div>
        )}
        {coupons.map(coupon => {
          const limitReached = coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit;
          const today = new Date().toISOString().slice(0, 10);
          const notStarted = coupon.startDate && today < coupon.startDate;
          const expired = coupon.endDate && today > coupon.endDate;
          const isInactive = !coupon.active || !!limitReached || !!notStarted || !!expired;
          return (
            <div key={coupon.id} style={{ border: `1.5px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <div onClick={() => { setEditing(coupon); setView('edit'); }} style={{ cursor: 'pointer', flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: C.dark, letterSpacing: 1 }}>{coupon.code}</span>
                    <span style={{ background: isInactive ? '#FEE2E2' : C.greenLight, color: isInactive ? '#EF4444' : C.green, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>
                      {!coupon.active ? 'Paused' : expired ? 'Expired' : notStarted ? 'Scheduled' : limitReached ? 'Limit reached' : 'Active'}
                    </span>
                  </div>
                  <p style={{ fontSize: 13, color: C.gray }}>
                    {coupon.type === 'percent' ? `${coupon.value}% off` : `${NAIRA}${coupon.value.toLocaleString()} off`}
                    {coupon.usageLimit !== null ? ` - ${coupon.usedCount}/${coupon.usageLimit} used` : ` - ${coupon.usedCount} used`}
                    {coupon.endDate ? ` - Expires ${coupon.endDate}` : ''}
                  </p>
                </div>
                <button onClick={() => handleCopy(coupon.code, coupon.id)} style={{ background: C.bg, border: 'none', borderRadius: 8, width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
                  <Copy size={14} color={copiedId === coupon.id ? C.green : C.gray} />
                </button>
              </div>
              <button
                onClick={() => handleToggleActive(coupon)}
                style={{ width: '100%', padding: '8px 0', borderRadius: 10, border: `1px solid ${C.border}`, background: C.white, color: C.gray, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
              >
                {coupon.active ? 'Pause coupon' : 'Resume coupon'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const EXPENSE_CATEGORIES: Expense['category'][] = ['Stock', 'Transport', 'Packaging', 'Marketing', 'Other'];

function BundleForm({ bundle, products, onSave, onCancel }: { bundle: Bundle | null; products: Product[]; onSave: (b: Bundle) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(bundle?.name || '');
  const [selectedIds, setSelectedIds] = useState<string[]>(bundle?.productIds || []);
  const [bundlePrice, setBundlePrice] = useState(bundle?.bundlePrice?.toString() || '');
  const [active, setActive] = useState(bundle?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const inp = { width: '100%', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 15, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };
  const label = { fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 };

  const toggleProduct = (id: string) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const originalTotal = products.filter(p => selectedIds.includes(p.id)).reduce((sum, p) => sum + (p.salePrice || p.price), 0);

  const handleSave = async () => {
    setError('');
    if (!name.trim()) { setError('Please give this bundle a name.'); return; }
    if (selectedIds.length < 2) { setError('Pick at least 2 products to make a bundle.'); return; }
    if (!bundlePrice || Number(bundlePrice) <= 0) { setError('Please enter a bundle price.'); return; }
    setSaving(true);
    try {
      await onSave({
        id: bundle?.id || Date.now().toString(),
        name: name.trim(),
        productIds: selectedIds,
        bundlePrice: Number(bundlePrice),
        active,
        createdAt: bundle?.createdAt || new Date().toISOString(),
      });
    } catch (err: any) {
      setError(err?.message || 'Could not save bundle.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 100, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onCancel} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><ArrowLeft size={18} color="white" /></button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>{bundle ? 'Edit Bundle' : 'New Bundle'}</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
        <div>
          <label style={label}>Bundle name</label>
          <input style={inp} placeholder="e.g. Starter Pack" value={name} onChange={e => setName(e.target.value)} />
        </div>

        <div>
          <label style={label}>Products in this bundle</label>
          <div style={{ border: `1.5px solid ${C.border}`, borderRadius: 12, overflow: 'hidden', maxHeight: 280, overflowY: 'auto' as const }}>
            {products.length === 0 && <p style={{ padding: 16, fontSize: 13, color: C.gray }}>Add some products first before creating a bundle.</p>}
            {products.map((p, i) => (
              <div key={p.id} onClick={() => toggleProduct(p.id)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderBottom: i < products.length - 1 ? `1px solid ${C.border}` : 'none', cursor: 'pointer', background: selectedIds.includes(p.id) ? `${C.navy}08` : C.white }}>
                <div style={{ width: 20, height: 20, borderRadius: 6, border: `2px solid ${selectedIds.includes(p.id) ? C.navy : C.border}`, background: selectedIds.includes(p.id) ? C.navy : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {selectedIds.includes(p.id) && <CheckCircle2 size={13} color="white" />}
                </div>
                <p style={{ fontSize: 13.5, color: C.dark, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>{p.name}</p>
                <p style={{ fontSize: 13, fontWeight: 700, color: C.gray, flexShrink: 0 }}>{NAIRA}{(p.salePrice || p.price).toLocaleString()}</p>
              </div>
            ))}
          </div>
        </div>

        {selectedIds.length >= 2 && (
          <div style={{ background: C.bg, borderRadius: 12, padding: '12px 14px' }}>
            <p style={{ fontSize: 12, color: C.gray }}>Original total if bought separately</p>
            <p style={{ fontSize: 16, fontWeight: 700, color: C.dark }}>{NAIRA}{originalTotal.toLocaleString()}</p>
          </div>
        )}

        <div>
          <label style={label}>Bundle price</label>
          <input style={inp} type="number" placeholder="e.g. 15000" value={bundlePrice} onChange={e => setBundlePrice(e.target.value)} />
          <p style={{ fontSize: 11, color: C.gray, marginTop: 6 }}>This should usually be less than the original total, so customers save by buying the bundle.</p>
        </div>

        <div onClick={() => setActive(!active)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: C.bg, borderRadius: 12, padding: '14px 16px', cursor: 'pointer' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: C.dark }}>Show on storefront</span>
          <div style={{ width: 44, height: 26, borderRadius: 13, background: active ? C.green : C.border, position: 'relative' as const, transition: 'background 0.2s' }}>
            <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'white', position: 'absolute' as const, top: 3, left: active ? 21 : 3, transition: 'left 0.2s' }} />
          </div>
        </div>

        {error && <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>}
        <button disabled={saving} onClick={handleSave} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
          {saving ? 'Saving...' : 'Save bundle'}
        </button>
      </div>
    </div>
  );
}

function BundlesScreen({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'list' | 'add' | 'edit'>('list');
  const [editing, setEditing] = useState<Bundle | null>(null);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    if (!user?.uid) return;
    const unsubBundles = onSnapshot(collection(db, 'merchants', user.uid, 'bundles'), (snap) => {
      const list: Bundle[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))
        .filter((b: any) => !b._deleted)
        .sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      setBundles(list);
      setLoading(false);
    }, () => setLoading(false));
    const unsubProducts = onSnapshot(collection(db, 'merchants', user.uid, 'products'), (snap) => {
      const list: Product[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).filter((p: any) => !p._deleted);
      setProducts(list);
    });
    return () => { unsubBundles(); unsubProducts(); };
  }, [user?.uid]);

  const handleSave = async (b: Bundle) => {
    if (!user?.uid) return;
    const { id, ...data } = b;
    await setDoc(doc(db, 'merchants', user.uid, 'bundles', id), data);
    setView('list');
    setEditing(null);
  };

  const handleDelete = async (id: string) => {
    if (!user?.uid) return;
    setActionError('');
    try {
      await setDoc(doc(db, 'merchants', user.uid, 'bundles', id), { _deleted: true }, { merge: true });
      setView('list');
      setEditing(null);
    } catch (err: any) {
      setActionError(err?.message || 'Could not delete bundle.');
    }
  };

  if (view === 'add') {
    return <BundleForm bundle={null} products={products} onSave={handleSave} onCancel={() => setView('list')} />;
  }
  if (view === 'edit' && editing) {
    return (
      <div>
        <BundleForm bundle={editing} products={products} onSave={handleSave} onCancel={() => { setView('list'); setEditing(null); }} />
        <div style={{ position: 'fixed' as const, bottom: 24, left: 20, right: 20 }}>
          <button onClick={() => handleDelete(editing.id)} style={{ width: '100%', background: '#FEE2E2', color: '#EF4444', border: 'none', borderRadius: 14, padding: 14, fontSize: 15, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Trash2 size={16} /> Delete bundle
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 32px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 22, fontWeight: 700, flex: 1 }}>Bundles</h2>
        <button onClick={() => setView('add')} style={{ background: C.green, border: 'none', borderRadius: 12, width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <Plus size={20} color="white" />
        </button>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20 }}>
        {actionError && (
          <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const, marginBottom: 16 }}>{actionError}</div>
        )}
        {loading && (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray, fontSize: 14 }}>Loading bundles...</div>
        )}
        {!loading && bundles.length === 0 && (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray, fontSize: 14 }}>
            <Package size={32} color={C.border} style={{ marginBottom: 12 }} />
            <p>No bundles yet. Tap + to package products together at a discount.</p>
          </div>
        )}
        {bundles.map(bundle => {
          const originalTotal = products.filter(p => bundle.productIds.includes(p.id)).reduce((sum, p) => sum + (p.salePrice || p.price), 0);
          return (
            <div key={bundle.id} onClick={() => { setEditing(bundle); setView('edit'); }} style={{ border: `1.5px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 12, cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: C.dark }}>{bundle.name}</span>
                <span style={{ background: bundle.active ? C.greenLight : '#FEE2E2', color: bundle.active ? C.green : '#EF4444', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>
                  {bundle.active ? 'Live' : 'Hidden'}
                </span>
              </div>
              <p style={{ fontSize: 13, color: C.gray, marginBottom: 8 }}>{bundle.productIds.length} products bundled together</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {originalTotal > bundle.bundlePrice && <span style={{ fontSize: 13, color: C.gray, textDecoration: 'line-through' as const }}>{NAIRA}{originalTotal.toLocaleString()}</span>}
                <span style={{ fontSize: 15, fontWeight: 800, color: C.navy }}>{NAIRA}{bundle.bundlePrice.toLocaleString()}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ExpenseForm({ expense, onSave, onDelete, onCancel }: { expense: Expense | null; onSave: (e: Expense) => Promise<void>; onDelete?: (id: string) => Promise<void>; onCancel: () => void }) {
  const isEdit = !!expense;
  const [title, setTitle] = useState(expense?.title || '');
  const [amount, setAmount] = useState(expense?.amount?.toString() || '');
  const [category, setCategory] = useState<Expense['category']>(expense?.category || 'Stock');
  const [note, setNote] = useState(expense?.note || '');
  const [date, setDate] = useState(expense?.date || new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const inp = { width: '100%', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 15, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };
  const label = { fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 };

  const handleSave = async () => {
    setError('');
    if (!title.trim()) {
      setError('Please enter what this expense was for.');
      return;
    }
    if (!amount || Number(amount) <= 0) {
      setError('Please enter a valid amount.');
      return;
    }
    setSaving(true);
    try {
      await onSave({
        id: expense?.id || Date.now().toString(),
        title: title.trim(),
        amount: Number(amount),
        category,
        note: category === 'Other' ? note.trim() || undefined : undefined,
        date,
        createdAt: expense?.createdAt || new Date().toISOString(),
      });
    } catch (err: any) {
      setError(err?.message || 'Could not save expense. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!expense || !onDelete) return;
    setDeleting(true);
    try {
      await onDelete(expense.id);
    } catch (err: any) {
      setError(err?.message || 'Could not delete expense.');
      setDeleting(false);
    }
  };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onCancel} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>{isEdit ? 'Edit Expense' : 'Add Expense'}</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
          <div>
            <label style={label}>What was this for?</label>
            <textarea
              style={{ ...inp, resize: 'vertical' as const, minHeight: 60, fontFamily: 'inherit', wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const }}
              placeholder="e.g. Restocked 20 shirts"
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={120}
            />
          </div>
          <div>
            <label style={label}>Amount ({NAIRA})</label>
            <input style={inp} type="number" placeholder="e.g. 45000" value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
          <div>
            <label style={label}>Category</label>
            <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 8 }}>
              {EXPENSE_CATEGORIES.map(c => (
                <button key={c} onClick={() => setCategory(c)} style={{ padding: '10px 16px', borderRadius: 10, border: `1.5px solid ${category === c ? C.navy : C.border}`, background: category === c ? C.navy : C.white, color: category === c ? 'white' : C.gray, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>{c}</button>
              ))}
            </div>
          </div>
          {category === 'Other' && (
            <div>
              <label style={label}>Add a note <span style={{ color: C.gray, fontWeight: 400 }}>(optional, just for you)</span></label>
              <textarea
                style={{ ...inp, resize: 'vertical' as const, minHeight: 90, fontFamily: 'inherit', wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const }}
                placeholder="Write a short note about what this expense was, for your own reference..."
                value={note}
                onChange={e => setNote(e.target.value)}
                maxLength={300}
              />
              <p style={{ fontSize: 11, color: C.gray, marginTop: 4, textAlign: 'right' as const }}>{note.length}/300</p>
            </div>
          )}
          <div>
            <label style={label}>Date</label>
            <input style={inp} type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          {error && (
            <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>
          )}
          <button disabled={saving || deleting} onClick={handleSave} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', marginTop: 8, opacity: saving || deleting ? 0.7 : 1 }}>
            {saving ? 'Saving...' : isEdit ? 'Save changes' : 'Add expense'}
          </button>
          {isEdit && onDelete && (
            <button disabled={saving || deleting} onClick={handleDelete} style={{ background: '#FEE2E2', color: '#EF4444', border: 'none', borderRadius: 14, padding: 14, fontSize: 15, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: saving || deleting ? 0.7 : 1 }}>
              <Trash2 size={16} /> {deleting ? 'Deleting...' : 'Delete expense'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const EXPENSE_CATEGORY_COLORS: any = {
  Stock: { bg: C.blueLight, color: C.blue },
  Transport: { bg: C.orangeLight, color: C.orange },
  Packaging: { bg: C.purpleLight, color: C.purple },
  Marketing: { bg: C.greenLight, color: C.green },
  Other: { bg: C.bg, color: C.gray },
};

function ExpensesScreen({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError] = useState('');
  const [view, setView] = useState<'list' | 'add' | 'edit'>('list');
  const [editing, setEditing] = useState<Expense | null>(null);

  useEffect(() => {
    if (!user?.uid) return;
    const unsub = onSnapshot(
      collection(db, 'merchants', user.uid, 'expenses'),
      (snap) => {
        const list: Expense[] = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .filter((e: any) => !e._deleted)
          .sort((a: any, b: any) => (b.date || '').localeCompare(a.date || ''));
        setExpenses(list);
        setLoading(false);
        setLoadError('');
      },
      () => {
        setLoading(false);
        setLoadError('Could not load expenses. Check your connection and try again.');
      }
    );
    return unsub;
  }, [user?.uid]);

  const handleSave = async (e: Expense) => {
    if (!user?.uid) {
      throw new Error('You are not signed in. Please log in again.');
    }
    const { id, ...rest } = e;
    const data: any = {};
    Object.keys(rest).forEach(key => {
      const value = (rest as any)[key];
      if (value !== undefined) data[key] = value;
    });
    await setDoc(doc(db, 'merchants', user.uid, 'expenses', id), data);
    setView('list');
    setEditing(null);
  };

  const handleDelete = async (id: string) => {
    if (!user?.uid) {
      throw new Error('You are not signed in. Please log in again.');
    }
    await setDoc(doc(db, 'merchants', user.uid, 'expenses', id), { _deleted: true }, { merge: true });
    setView('list');
    setEditing(null);
  };

  if (view === 'add') {
    return <ExpenseForm expense={null} onSave={handleSave} onCancel={() => setView('list')} />;
  }
  if (view === 'edit' && editing) {
    return <ExpenseForm expense={editing} onSave={handleSave} onDelete={handleDelete} onCancel={() => { setView('list'); setEditing(null); }} />;
  }

  const totalThisMonth = expenses
    .filter(e => e.date.slice(0, 7) === new Date().toISOString().slice(0, 7))
    .reduce((sum, e) => sum + e.amount, 0);

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 32px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 22, fontWeight: 700, flex: 1 }}>Expenses</h2>
        <button onClick={() => setView('add')} style={{ background: C.green, border: 'none', borderRadius: 12, width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <Plus size={20} color="white" />
        </button>
      </div>
      <div style={{ padding: '0 16px', marginTop: -16 }}>
        <div style={{ background: `linear-gradient(135deg, ${C.navy} 0%, #0E2038 100%)`, borderRadius: 20, padding: '16px 18px', marginBottom: 16, boxShadow: '0 8px 32px rgba(20,42,69,0.35)' }}>
          <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginBottom: 6 }}>This month's expenses</p>
          <h1 style={{ color: 'white', fontSize: 30, fontWeight: 800 }}>{NAIRA}{totalThisMonth.toLocaleString()}</h1>
        </div>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', padding: 20 }}>
        {actionError && (
          <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const, marginBottom: 16 }}>{actionError}</div>
        )}
        {loadError && (
          <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const, marginBottom: 16 }}>{loadError}</div>
        )}
        {loading && !loadError && (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray, fontSize: 14 }}>Loading expenses...</div>
        )}
        {!loading && expenses.length === 0 && !loadError && (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray, fontSize: 14 }}>
            <Wallet size={32} color={C.border} style={{ marginBottom: 12 }} />
            <p>No expenses logged yet. Tap + to record one.</p>
          </div>
        )}
        {expenses.map(expense => (
          <div key={expense.id} onClick={() => { setEditing(expense); setView('edit'); }} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '14px 0', borderBottom: `1px solid ${C.border}`, cursor: 'pointer', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flex: 1, minWidth: 0 }}>
              <div style={{ width: 46, height: 46, background: EXPENSE_CATEGORY_COLORS[expense.category]?.bg, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Wallet size={18} color={EXPENSE_CATEGORY_COLORS[expense.category]?.color} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 15, fontWeight: 600, color: C.dark, marginBottom: 2, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const }}>{expense.title}</p>
                <p style={{ fontSize: 12, color: C.gray }}>{expense.category} - {new Date(expense.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</p>
                {expense.note && (
                  <p style={{ fontSize: 12, color: C.gray, marginTop: 4, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, fontStyle: 'italic' as const }}>{expense.note}</p>
                )}
              </div>
            </div>
            <p style={{ fontSize: 14, fontWeight: 700, color: '#EF4444', flexShrink: 0 }}>-{NAIRA}{expense.amount.toLocaleString()}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function StarRow({ rating, size = 14 }: { rating: number; size?: number }) {
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} size={size} color={i <= rating ? '#F59E0B' : '#E5E7EB'} fill={i <= rating ? '#F59E0B' : 'none'} />
      ))}
    </div>
  );
}

function ReviewsScreen({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user?.uid) return;
    const unsub = onSnapshot(
      collection(db, 'merchants', user.uid, 'reviews'),
      (snap) => {
        const list: Review[] = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as any) }))
          .sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        setReviews(list);
        setLoading(false);
      },
      () => { setLoading(false); setError('Could not load reviews. Check your connection and try again.'); }
    );
    return unsub;
  }, [user?.uid]);

  const handleDelete = async (id: string) => {
    if (!user?.uid) return;
    setDeletingId(id);
    try {
      await deleteDoc(doc(db, 'merchants', user.uid, 'reviews', id));
    } catch (err: any) {
      setError(err?.message || 'Could not delete review. Please try again.');
    } finally {
      setDeletingId(null);
    }
  };

  const avgRating = reviews.length > 0 ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 32px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 22, fontWeight: 700 }}>Customer Reviews</h2>
      </div>

      <div style={{ padding: '0 16px', marginTop: -16 }}>
        <div style={{ background: C.white, borderRadius: 16, padding: 18, marginBottom: 16, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', display: 'flex', alignItems: 'center', gap: 16 }}>
          <div>
            <p style={{ fontSize: 28, fontWeight: 800, color: C.dark }}>{avgRating.toFixed(1)}</p>
            <StarRow rating={Math.round(avgRating)} size={13} />
          </div>
          <div style={{ width: 1, height: 36, background: C.border }} />
          <div>
            <p style={{ fontSize: 20, fontWeight: 700, color: C.dark }}>{reviews.length}</p>
            <p style={{ fontSize: 12, color: C.gray }}>Total review{reviews.length !== 1 ? 's' : ''}</p>
          </div>
        </div>
      </div>

      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', padding: 20 }}>
        {error && (
          <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const, marginBottom: 16 }}>{error}</div>
        )}
        {loading && (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray, fontSize: 14 }}>Loading reviews...</div>
        )}
        {!loading && reviews.length === 0 && (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray, fontSize: 14 }}>
            <Star size={32} color={C.border} style={{ marginBottom: 12 }} />
            <p>No reviews yet. They'll show up here as customers rate your products.</p>
          </div>
        )}
        {reviews.map(r => (
          <div key={r.id} style={{ border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
              <div>
                <p style={{ fontSize: 14, fontWeight: 700, color: C.dark, marginBottom: 2 }}>{r.customerName || 'Anonymous'}</p>
                <p style={{ fontSize: 12, color: C.gray, marginBottom: 6 }}>on {r.productName}</p>
                <StarRow rating={r.rating} />
              </div>
              <button
                disabled={deletingId === r.id}
                onClick={() => handleDelete(r.id)}
                style={{ background: '#FEE2E2', border: 'none', borderRadius: 8, width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, opacity: deletingId === r.id ? 0.5 : 1 }}
              >
                <Trash2 size={14} color="#EF4444" />
              </button>
            </div>
            {r.comment && <p style={{ fontSize: 13, color: C.dark, lineHeight: 1.5 }}>{r.comment}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function AnnouncementScreen({ onBack }: { onBack: () => void }) {
  const { user, updateProfile } = useAuth();
  const [text, setText] = useState(user?.announcementBanner || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const inp = { width: '100%', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 15, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };
  const label = { fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 };

  const handleSave = async () => {
    setError('');
    setSaving(true);
    try {
      await updateProfile({ announcementBanner: text.trim() || undefined });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err?.message || 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const examples = [
    'Free delivery on orders over ' + NAIRA + '20,000',
    'Orders arrive within 7-14 days',
    'New arrivals every Friday!',
  ];

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>Announcement Banner</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
          <p style={{ fontSize: 13, color: C.gray, lineHeight: 1.6 }}>
            Show a short message at the very top of your storefront - shipping info, delivery timelines, or anything customers should know before they shop. Leave it blank to hide it.
          </p>
          <div>
            <label style={label}>Banner message</label>
            <textarea
              style={{ ...inp, minHeight: 80, resize: 'vertical' as const, fontFamily: 'inherit' }}
              placeholder="e.g. Free delivery on orders over â‚¦20,000"
              value={text}
              onChange={e => setText(e.target.value)}
              maxLength={120}
            />
            <p style={{ fontSize: 11, color: C.gray, marginTop: 4, textAlign: 'right' as const }}>{text.length}/120</p>
          </div>
          <div>
            <p style={{ fontSize: 12, fontWeight: 600, color: C.gray, marginBottom: 8 }}>Examples</p>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
              {examples.map(ex => (
                <button key={ex} onClick={() => setText(ex)} style={{ textAlign: 'left' as const, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 14px', fontSize: 13, color: C.dark, cursor: 'pointer' }}>{ex}</button>
              ))}
            </div>
          </div>
          {error && (
            <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>
          )}
          {saved && (
            <div style={{ background: C.greenLight, color: C.green, borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle2 size={16} /> Saved
            </div>
          )}
          <button disabled={saving} onClick={handleSave} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SaleCountdownScreen({ onBack }: { onBack: () => void }) {
  const { user, updateProfile } = useAuth();
  const [enabled, setEnabled] = useState(!!user?.saleEndsAt);
  const [date, setDate] = useState(user?.saleEndsAt ? user.saleEndsAt.slice(0, 10) : '');
  const [time, setTime] = useState(user?.saleEndsAt ? user.saleEndsAt.slice(11, 16) : '23:59');
  const [label, setLabelText] = useState(user?.saleLabel || 'Sale ends in');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const inp = { width: '100%', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 15, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };
  const lbl = { fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 };

  const handleSave = async () => {
    setError('');
    if (enabled && !date) { setError('Please pick an end date for your sale.'); return; }
    setSaving(true);
    try {
      const saleEndsAt = enabled ? `${date}T${time}:00` : undefined;
      if (enabled && saleEndsAt && new Date(saleEndsAt).getTime() <= Date.now()) {
        setError('That date and time has already passed - pick one in the future.');
        setSaving(false);
        return;
      }
      await updateProfile({ saleEndsAt, saleLabel: enabled ? (label.trim() || 'Sale ends in') : undefined });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err?.message || 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>Sale Countdown Timer</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
          <p style={{ fontSize: 13, color: C.gray, lineHeight: 1.6 }}>
            Show a live ticking countdown on your storefront to create urgency for a limited-time sale. It disappears automatically once time runs out.
          </p>

          <div onClick={() => setEnabled(!enabled)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: C.bg, borderRadius: 12, padding: '14px 16px', cursor: 'pointer' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: C.dark }}>Show countdown on storefront</span>
            <div style={{ width: 44, height: 26, borderRadius: 13, background: enabled ? C.green : C.border, position: 'relative' as const, transition: 'background 0.2s' }}>
              <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'white', position: 'absolute' as const, top: 3, left: enabled ? 21 : 3, transition: 'left 0.2s' }} />
            </div>
          </div>

          {enabled && (
            <>
              <div>
                <label style={lbl}>Countdown label</label>
                <input style={inp} placeholder="e.g. Sale ends in" value={label} onChange={e => setLabelText(e.target.value)} maxLength={40} />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={lbl}>End date</label>
                  <input style={inp} type="date" value={date} onChange={e => setDate(e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={lbl}>End time</label>
                  <input style={inp} type="time" value={time} onChange={e => setTime(e.target.value)} />
                </div>
              </div>
            </>
          )}

          {error && (
            <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>
          )}
          {saved && (
            <div style={{ background: C.greenLight, color: C.green, borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle2 size={16} /> Saved
            </div>
          )}
          <button disabled={saving} onClick={handleSave} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}


function CartTimerScreen({ onBack }: { onBack: () => void }) {
  const { user, updateProfile } = useAuth();
  const [enabled, setEnabled] = useState(!!user?.cartTimerMinutes);
  const [minutes, setMinutes] = useState(user?.cartTimerMinutes?.toString() || '30');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const inp = { width: '100%', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 15, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };
  const presets = [15, 30, 60, 120];

  const handleSave = async () => {
    setError('');
    if (enabled && (!minutes || Number(minutes) < 1)) { setError('Please enter how many minutes to reserve a cart for.'); return; }
    setSaving(true);
    try {
      await updateProfile({ cartTimerMinutes: enabled ? Number(minutes) : undefined });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err?.message || 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>Cart Timer</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
          <p style={{ fontSize: 13, color: C.gray, lineHeight: 1.6 }}>
            Show customers a countdown once they start checking out, encouraging them to complete their order before their cart clears.
          </p>
          <div style={{ background: C.blueLight, borderRadius: 12, padding: '12px 14px' }}>
            <p style={{ fontSize: 12, color: C.blue, lineHeight: 1.5 }}>
              Good to know: this creates urgency and clears an abandoned cart after time runs out, but it doesn't yet stop two customers
              from ordering the same item at the same time - that needs a feature we haven't built yet.
            </p>
          </div>

          <div onClick={() => setEnabled(!enabled)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: C.bg, borderRadius: 12, padding: '14px 16px', cursor: 'pointer' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: C.dark }}>Enable cart timer</span>
            <div style={{ width: 44, height: 26, borderRadius: 13, background: enabled ? C.green : C.border, position: 'relative' as const, transition: 'background 0.2s' }}>
              <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'white', position: 'absolute' as const, top: 3, left: enabled ? 21 : 3, transition: 'left 0.2s' }} />
            </div>
          </div>

          {enabled && (
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Reserve cart for (minutes)</label>
              <input style={inp} type="number" placeholder="30" value={minutes} onChange={e => setMinutes(e.target.value)} />
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                {presets.map(p => (
                  <button key={p} onClick={() => setMinutes(p.toString())} style={{ flex: 1, background: minutes === p.toString() ? C.navy : C.bg, color: minutes === p.toString() ? 'white' : C.dark, border: 'none', borderRadius: 10, padding: '9px 0', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                    {p >= 60 ? `${p / 60}h` : `${p}m`}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>
          )}
          {saved && (
            <div style={{ background: C.greenLight, color: C.green, borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle2 size={16} /> Saved
            </div>
          )}
          <button disabled={saving} onClick={handleSave} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}


function ConnectedToolsScreen({ onBack }: { onBack: () => void }) {
  const { user, updateProfile } = useAuth();
  const [facebookPixelId, setFacebookPixelId] = useState(user?.facebookPixelId || '');
  const [googleAnalyticsId, setGoogleAnalyticsId] = useState(user?.googleAnalyticsId || '');
  const [customTrackingCode, setCustomTrackingCode] = useState(user?.customTrackingCode || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const inp = { width: '100%', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 15, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };
  const lbl = { fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 };

  const handleSave = async () => {
    setError('');
    setSaving(true);
    try {
      await updateProfile({
        facebookPixelId: facebookPixelId.trim() || undefined,
        googleAnalyticsId: googleAnalyticsId.trim() || undefined,
        customTrackingCode: customTrackingCode.trim() || undefined,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err?.message || 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>Connected Tools</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 20 }}>
          <p style={{ fontSize: 13, color: C.gray, lineHeight: 1.6 }}>
            Connect your storefront to advertising and analytics tools so you can track visits, product views, and sales -
            useful once you start running ads.
          </p>

          <div>
            <label style={lbl}>Facebook Pixel ID</label>
            <input style={inp} placeholder="e.g. 1234567890123456" value={facebookPixelId} onChange={e => setFacebookPixelId(e.target.value)} />
            <p style={{ fontSize: 11, color: C.gray, marginTop: 6 }}>Find this in Facebook Events Manager. Tracks visits and purchases for Facebook/Instagram ads.</p>
          </div>

          <div>
            <label style={lbl}>Google Analytics ID</label>
            <input style={inp} placeholder="e.g. G-XXXXXXXXXX" value={googleAnalyticsId} onChange={e => setGoogleAnalyticsId(e.target.value)} />
            <p style={{ fontSize: 11, color: C.gray, marginTop: 6 }}>Find this under Admin - Data Streams in Google Analytics.</p>
          </div>

          <div>
            <label style={lbl}>Custom Tracking Code (any other tool)</label>
            <textarea
              style={{ ...inp, minHeight: 110, resize: 'vertical' as const, fontFamily: 'monospace', fontSize: 12.5 }}
              placeholder="Paste any script code given to you by TikTok Pixel, Snapchat Pixel, Hotjar, or any other tool"
              value={customTrackingCode}
              onChange={e => setCustomTrackingCode(e.target.value)}
            />
            <p style={{ fontSize: 11, color: C.gray, marginTop: 6 }}>
              Works for any tool that gives you a code snippet to add to your website - not just the two above.
            </p>
          </div>

          {error && (
            <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>
          )}
          {saved && (
            <div style={{ background: C.greenLight, color: C.green, borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle2 size={16} /> Saved
            </div>
          )}
          <button disabled={saving} onClick={handleSave} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}


function ShippingRatesScreen({ onBack }: { onBack: () => void }) {
  const { user, updateProfile } = useAuth();
  const [rates, setRates] = useState<{ state: string; fee: string }[]>(
    user?.shippingRates ? Object.entries(user.shippingRates).map(([state, fee]: any) => ({ state, fee: fee.toString() })) : []
  );
  const [defaultFee, setDefaultFee] = useState(user?.defaultShippingFee?.toString() || '');
  const [newState, setNewState] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const inp = { width: '100%', padding: '12px 14px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 14, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };
  const availableStates = NIGERIAN_STATES.filter(s => !rates.some(r => r.state === s));

  const addState = () => {
    if (!newState) return;
    setRates([...rates, { state: newState, fee: '' }]);
    setNewState('');
  };

  const handleSave = async () => {
    setError('');
    for (const r of rates) {
      if (!r.fee || Number(r.fee) < 0) { setError(`Please enter a delivery fee for ${r.state}.`); return; }
    }
    setSaving(true);
    try {
      const shippingRates: { [state: string]: number } = {};
      rates.forEach(r => { shippingRates[r.state] = Number(r.fee); });
      await updateProfile({
        shippingRates: Object.keys(shippingRates).length > 0 ? shippingRates : undefined,
        defaultShippingFee: defaultFee ? Number(defaultFee) : undefined,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err?.message || 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>Shipping Rates</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
          <p style={{ fontSize: 13, color: C.gray, lineHeight: 1.6 }}>
            Set a delivery fee per state. Customers will see the correct fee added automatically once they enter their delivery
            state at checkout. States you don't list will use your default fee below.
          </p>

          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Default delivery fee</label>
            <input style={inp} type="number" placeholder="e.g. 2000 (used for any state not listed below)" value={defaultFee} onChange={e => setDefaultFee(e.target.value)} />
          </div>

          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 10 }}>Rates by state</label>
            {rates.map((r, i) => (
              <div key={r.state} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <span style={{ flex: 1, fontSize: 13.5, color: C.dark, fontWeight: 600 }}>{r.state}</span>
                <div style={{ width: 120 }}>
                  <input style={inp} type="number" placeholder="Fee" value={r.fee} onChange={e => setRates(rates.map((x, j) => j === i ? { ...x, fee: e.target.value } : x))} />
                </div>
                <button onClick={() => setRates(rates.filter((_, j) => j !== i))} style={{ background: '#FEE2E2', border: 'none', borderRadius: 8, width: 36, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}><Trash2 size={14} color="#EF4444" /></button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={newState} onChange={e => setNewState(e.target.value)} style={{ ...inp, flex: 1 }}>
                <option value="">Select a state to add</option>
                {availableStates.map(s => <option key={s}>{s}</option>)}
              </select>
              <button onClick={addState} disabled={!newState} style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 12, padding: '0 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: !newState ? 0.5 : 1 }}>Add</button>
            </div>
          </div>

          {error && (
            <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>
          )}
          {saved && (
            <div style={{ background: C.greenLight, color: C.green, borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle2 size={16} /> Saved
            </div>
          )}
          <button disabled={saving} onClick={handleSave} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}


function ChecklistItemScreen({ title, onBack, onSave, children, saving, error }: any) {
  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>{title}</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
          {children}
          {error && (
            <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>
          )}
          <button disabled={saving} onClick={onSave} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', marginTop: 8, opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Lets a merchant define their own delivery couriers (e.g. "GIG Logistics", "Local Dispatch
// Rider"), each with a real cost price (what the merchant actually pays) and a customer-facing
// price (what the customer is charged) - the merchant can build in a margin between the two.
// Customers pick one of these at checkout instead of a single flat state-based fee, once at
// least one active courier exists.
function CouriersScreen({ onBack }: { onBack: () => void }) {
  const { user, updateProfile } = useAuth();
  const [couriers, setCouriers] = useState<Courier[]>(user?.couriers || []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const inp = { width: '100%', padding: '12px 14px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 14, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };

  const addCourier = () => {
    setCouriers([...couriers, { id: Date.now().toString(), name: '', costPrice: 0, customerPrice: 0, estimatedDays: '', active: true }]);
  };

  const updateCourier = (id: string, patch: Partial<Courier>) => {
    setCouriers(couriers.map(c => c.id === id ? { ...c, ...patch } : c));
  };

  const removeCourier = (id: string) => {
    setCouriers(couriers.filter(c => c.id !== id));
  };

  const handleSave = async () => {
    setError('');
    for (const c of couriers) {
      if (!c.name.trim()) { setError('Please name every courier you add.'); return; }
      if (c.customerPrice < 0) { setError('Prices cannot be negative.'); return; }
    }
    setSaving(true);
    try {
      await updateProfile({ couriers: couriers.length > 0 ? couriers : undefined });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err?.message || 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>Delivery Couriers</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
          <p style={{ fontSize: 13, color: C.gray, lineHeight: 1.6 }}>
            Add the couriers you actually use, and the price you want to charge customers for
            each one. If you don't add any couriers here, checkout falls back to your Shipping
            Rates by state instead.
          </p>

          {couriers.map((c) => (
            <div key={c.id} style={{ border: `1.5px solid ${C.border}`, borderRadius: 14, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <input
                  style={{ ...inp, flex: 1, fontWeight: 700 }}
                  placeholder="e.g. GIG Logistics"
                  value={c.name}
                  onChange={e => updateCourier(c.id, { name: e.target.value })}
                />
                <button onClick={() => removeCourier(c.id)} style={{ background: '#FEE2E2', border: 'none', borderRadius: 8, width: 36, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, marginLeft: 8 }}><Trash2 size={14} color="#EF4444" /></button>
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 11.5, color: C.gray, display: 'block', marginBottom: 4 }}>Delivery price</label>
                <input style={inp} type="number" placeholder="0" value={c.customerPrice || ''} onChange={e => updateCourier(c.id, { customerPrice: Number(e.target.value) })} />
              </div>
              <input
                style={inp}
                placeholder="Estimated delivery time (e.g. 1-2 days)"
                value={c.estimatedDays || ''}
                onChange={e => updateCourier(c.id, { estimatedDays: e.target.value })}
              />
            </div>
          ))}

          <button onClick={addCourier} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: C.bg, border: `1.5px dashed ${C.border}`, borderRadius: 12, padding: 14, fontSize: 13.5, fontWeight: 700, color: C.navy, cursor: 'pointer' }}>
            <Plus size={15} /> Add a courier
          </button>

          {error && (
            <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600 }}>{error}</div>
          )}
          {saved && (
            <div style={{ background: C.greenLight, color: C.green, borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle2 size={16} /> Saved
            </div>
          )}
          <button disabled={saving} onClick={handleSave} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Lets a merchant define their own custom questions to ask every customer at checkout (e.g.
// "Gift message", "Preferred delivery time") - answers get saved onto each order automatically.
function CheckoutFieldsScreen({ onBack }: { onBack: () => void }) {
  const { user, updateProfile } = useAuth();
  const [fields, setFields] = useState<CheckoutField[]>(user?.checkoutFields || []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const inp = { width: '100%', padding: '12px 14px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 14, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };

  const addField = () => {
    setFields([...fields, { id: Date.now().toString(), label: '', required: false }]);
  };

  const updateField = (id: string, patch: Partial<CheckoutField>) => {
    setFields(fields.map(f => f.id === id ? { ...f, ...patch } : f));
  };

  const removeField = (id: string) => {
    setFields(fields.filter(f => f.id !== id));
  };

  const handleSave = async () => {
    setError('');
    for (const f of fields) {
      if (!f.label.trim()) { setError('Please give every field a label.'); return; }
    }
    setSaving(true);
    try {
      await updateProfile({ checkoutFields: fields.length > 0 ? fields : undefined });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err?.message || 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>Checkout Fields</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
          <p style={{ fontSize: 13, color: C.gray, lineHeight: 1.6 }}>
            Add your own questions to ask customers at checkout - like a gift message, preferred
            delivery time, or special instructions. Their answers get saved with the order so
            you can see them right away.
          </p>

          {fields.map((f) => (
            <div key={f.id} style={{ border: `1.5px solid ${C.border}`, borderRadius: 14, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <input
                  style={{ ...inp, flex: 1, fontWeight: 700 }}
                  placeholder="e.g. Gift message"
                  value={f.label}
                  onChange={e => updateField(f.id, { label: e.target.value })}
                />
                <button onClick={() => removeField(f.id)} style={{ background: '#FEE2E2', border: 'none', borderRadius: 8, width: 36, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, marginLeft: 8 }}><Trash2 size={14} color="#EF4444" /></button>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.dark, cursor: 'pointer' }}>
                <input type="checkbox" checked={f.required} onChange={e => updateField(f.id, { required: e.target.checked })} />
                Required - customer must answer this to check out
              </label>
            </div>
          ))}

          <button onClick={addField} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: C.bg, border: `1.5px dashed ${C.border}`, borderRadius: 12, padding: 14, fontSize: 13.5, fontWeight: 700, color: C.navy, cursor: 'pointer' }}>
            <Plus size={15} /> Add a field
          </button>

          {error && (
            <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600 }}>{error}</div>
          )}
          {saved && (
            <div style={{ background: C.greenLight, color: C.green, borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle2 size={16} /> Saved
            </div>
          )}
          <button disabled={saving} onClick={handleSave} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Lets a merchant write their own Terms & Conditions, shown to customers at checkout with a
// required checkbox. The exact text they agreed to, plus the exact moment they ticked it, is
// saved onto the order itself - real proof for the merchant if a dispute ever comes up, since
// it's a snapshot at the time of purchase, not just a link to whatever the terms say today.
function TermsScreen({ onBack }: { onBack: () => void }) {
  const { user, updateProfile } = useAuth();
  const [text, setText] = useState(user?.termsAndConditions || '');
  const [required, setRequired] = useState(user?.termsRequired !== false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    setError('');
    setSaving(true);
    try {
      await updateProfile({ termsAndConditions: text.trim() || undefined, termsRequired: required });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err?.message || 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>Terms & Conditions</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
          <p style={{ fontSize: 13, color: C.gray, lineHeight: 1.6 }}>
            Write your own store policy - refunds, delivery expectations, product condition,
            anything you want customers to agree to. This exact text is shown at checkout with a
            checkbox, and gets saved onto every order along with the exact time it was ticked -
            real proof of what the customer agreed to if a dispute ever comes up.
          </p>

          <div>
            <label style={{ fontSize: 12.5, fontWeight: 700, color: C.dark, display: 'block', marginBottom: 8 }}>Your terms</label>
            <textarea
              style={{ width: '100%', padding: '12px 14px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 13.5, outline: 'none', minHeight: 180, resize: 'vertical' as const, fontFamily: 'inherit', boxSizing: 'border-box' as const }}
              placeholder="e.g. All sales are final after 24 hours. Products are as described and pictured. Delivery times are estimates, not guarantees..."
              value={text}
              onChange={e => setText(e.target.value)}
            />
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.dark, cursor: 'pointer' }}>
            <input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)} />
            Customer must tick the box to check out (recommended)
          </label>

          {error && (
            <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600 }}>{error}</div>
          )}
          {saved && (
            <div style={{ background: C.greenLight, color: C.green, borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle2 size={16} /> Saved
            </div>
          )}
          <button disabled={saving} onClick={handleSave} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Lets a merchant change how they sell after onboarding - fulfils the promise made during
// onboarding itself ("you can always change this later"). Switching to "in-person only"
// hides the store link and Orders tab (since Orders only ever shows online checkouts);
// switching back to online/both brings them back immediately.
function SellingModeScreen({ onBack }: { onBack: () => void }) {
  const { user, updateProfile } = useAuth();
  const [sellingMode, setSellingMode] = useState(user?.sellingMode || 'online');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const options = [
    { id: 'online', title: 'Online, with a store link I can share', sub: 'Customers browse and checkout on your own store link' },
    { id: 'in-person', title: 'In person only', sub: 'I sell face to face, I do not need an online store' },
    { id: 'both', title: 'Both', sub: 'I sell online and in person' },
  ];

  const handleSave = async () => {
    setError('');
    setSaving(true);
    try {
      await updateProfile({ sellingMode });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError(err?.message || 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>Selling Style</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
          <p style={{ fontSize: 13, color: C.gray, lineHeight: 1.6 }}>
            How you sell. Choosing "In person only" hides your store link and the Orders tab,
            since those only apply to online sales, your Point of Sale keeps working exactly
            the same either way.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
            {options.map(opt => {
              const selected = sellingMode === opt.id;
              return (
                <button key={opt.id} onClick={() => setSellingMode(opt.id)} style={{ display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' as const, background: selected ? `${C.navy}0d` : C.white, border: `2px solid ${selected ? C.navy : C.border}`, borderRadius: 14, padding: '14px 16px', cursor: 'pointer' }}>
                  <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${selected ? C.navy : C.border}`, background: selected ? C.navy : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {selected && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'white' }} />}
                  </div>
                  <div>
                    <p style={{ fontSize: 14, fontWeight: 700, color: C.dark, marginBottom: 2 }}>{opt.title}</p>
                    <p style={{ fontSize: 12, color: C.gray }}>{opt.sub}</p>
                  </div>
                </button>
              );
            })}
          </div>

          {error && (
            <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600 }}>{error}</div>
          )}
          {saved && (
            <div style={{ background: C.greenLight, color: C.green, borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
              <CheckCircle2 size={16} /> Saved
            </div>
          )}
          <button disabled={saving} onClick={handleSave} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Real account controls: reuses the same password-reset email system already built for the
// login screen, lets a merchant choose which notification types actually reach them, and
// points anything as serious as account deletion to a real person rather than an instant,
// unrecoverable self-serve button.
function SettingsScreen({ onBack }: { onBack: () => void }) {
  const { user, updateProfile, resetPassword } = useAuth();
  const [resetSent, setResetSent] = useState(false);
  const [resetError, setResetError] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [notifs, setNotifs] = useState({
    newOrder: user?.notifyNewOrder !== false,
    lowStock: user?.notifyLowStock !== false,
    newReview: user?.notifyNewReview !== false,
    staffJoined: user?.notifyStaffJoined !== false,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handlePasswordReset = async () => {
    setResetError('');
    if (!user?.email) { setResetError('No email found on this account.'); return; }
    setResetLoading(true);
    try {
      await resetPassword(user.email);
      setResetSent(true);
    } catch (err: any) {
      setResetError('Could not send reset email. Please try again.');
    } finally {
      setResetLoading(false);
    }
  };

  const [pushStatus, setPushStatus] = useState<'idle' | 'requesting' | 'enabled' | 'denied' | 'error' | 'unsupported'>(
    () => (user?.fcmTokens && user.fcmTokens.length > 0) ? 'enabled' : 'idle'
  );
  const [pushError, setPushError] = useState('');

  // Turns on real phone notifications for this specific device - the browser asks the merchant
  // for permission, then a unique token identifying this device/browser gets saved to their
  // profile so the backend knows where to actually deliver a push when a new sale comes in.
  const [testPushResult, setTestPushResult] = useState('');
  const [testPushSending, setTestPushSending] = useState(false);

  // Sends a real test notification right now and shows the exact response on screen - much
  // easier to read than digging through Vercel's own logs.
  const handleSendTestPush = async () => {
    setTestPushResult('');
    if (!user?.fcmTokens || user.fcmTokens.length === 0) {
      setTestPushResult('No device token saved yet - enable notifications first.');
      return;
    }
    setTestPushSending(true);
    try {
      const res = await fetch('https://sales-pilot-payment.vercel.app/api/send-push-notification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokens: user.fcmTokens,
          title: 'Test notification',
          body: 'If you see this, phone notifications are working.',
        }),
      });
      const data = await res.json();
      setTestPushResult(`Status ${res.status}: ${JSON.stringify(data)}`);
    } catch (err: any) {
      setTestPushResult(`Network error: ${err?.message || 'unknown'}`);
    } finally {
      setTestPushSending(false);
    }
  };

  const handleEnablePush = async () => {
    setPushError('');
    if (!('Notification' in window) || !('serviceWorker' in navigator)) {
      setPushStatus('unsupported');
      return;
    }
    if (!FCM_VAPID_KEY) {
      setPushError('Push notifications are not fully set up on this app yet. Check back soon.');
      return;
    }
    setPushStatus('requesting');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setPushStatus('denied');
        return;
      }
      const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
      const { getMessaging, getToken } = await import('firebase/messaging');
      const messaging = getMessaging();
      const token = await getToken(messaging, { vapidKey: FCM_VAPID_KEY, serviceWorkerRegistration: registration });
      if (!token || !user?.uid) throw new Error('no-token');
      await setDoc(doc(db, 'merchants', user.uid), { fcmTokens: arrayUnion(token) }, { merge: true });
      setPushStatus('enabled');
    } catch (err) {
      setPushStatus('error');
    }
  };

  const handleSaveNotifs = async () => {
    setSaving(true);
    try {
      await updateProfile({ notifyNewOrder: notifs.newOrder, notifyLowStock: notifs.lowStock, notifyNewReview: notifs.newReview, notifyStaffJoined: notifs.staffJoined });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const NotifToggle = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) => (
    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}>
      <span style={{ fontSize: 14, color: C.dark, fontWeight: 600 }}>{label}</span>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ width: 20, height: 20 }} />
    </label>
  );

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>Settings</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>

        <p style={{ fontSize: 12, fontWeight: 800, color: C.gray, textTransform: 'uppercase' as const, letterSpacing: 0.6, marginBottom: 10 }}>Account</p>
        <div style={{ border: `1.5px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 24 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: C.dark, marginBottom: 4 }}>Change Password</p>
          <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 12 }}>We'll email a reset link to {user?.email || 'your account email'}.</p>
          {resetSent ? (
            <div style={{ background: C.greenLight, color: C.green, borderRadius: 10, padding: '10px 12px', fontSize: 12.5, fontWeight: 600 }}>Reset link sent. Check your inbox.</div>
          ) : (
            <button disabled={resetLoading} onClick={handlePasswordReset} style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 10, padding: '10px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: resetLoading ? 0.7 : 1 }}>
              {resetLoading ? 'Sending...' : 'Send Reset Link'}
            </button>
          )}
          {resetError && <p style={{ color: '#EF4444', fontSize: 12, marginTop: 8 }}>{resetError}</p>}
        </div>

        <p style={{ fontSize: 12, fontWeight: 800, color: C.gray, textTransform: 'uppercase' as const, letterSpacing: 0.6, marginBottom: 10 }}>Notifications</p>

        <div style={{ border: `1.5px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <div style={{ width: 40, height: 40, background: C.blueLight, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Bell size={18} color={C.blue} />
            </div>
            <div>
              <p style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>Phone Notifications</p>
              <p style={{ fontSize: 12, color: C.gray }}>Get notified the moment a sale comes in, even with the app closed</p>
            </div>
          </div>
          {pushStatus === 'enabled' ? (
            <div>
              <div style={{ background: C.greenLight, color: C.green, borderRadius: 10, padding: '10px 12px', fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                <CheckCircle2 size={14} /> Enabled on this device
              </div>
              <button disabled={testPushSending} onClick={handleSendTestPush} style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 10, padding: '10px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: testPushSending ? 0.7 : 1 }}>
                {testPushSending ? 'Sending...' : 'Send Test Notification'}
              </button>
              {testPushResult && (
                <p style={{ fontSize: 11.5, color: C.dark, marginTop: 8, wordBreak: 'break-word' as const, background: C.bg, borderRadius: 8, padding: 10 }}>{testPushResult}</p>
              )}
            </div>
          ) : pushStatus === 'denied' ? (
            <p style={{ fontSize: 12.5, color: '#EF4444' }}>Notifications were blocked. Enable them for this site in your phone's browser settings, then try again.</p>
          ) : pushStatus === 'unsupported' ? (
            <p style={{ fontSize: 12.5, color: C.gray }}>Your current browser doesn't support phone notifications.</p>
          ) : (
            <button disabled={pushStatus === 'requesting'} onClick={handleEnablePush} style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 10, padding: '10px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: pushStatus === 'requesting' ? 0.7 : 1 }}>
              {pushStatus === 'requesting' ? 'Requesting...' : 'Enable on This Device'}
            </button>
          )}
          {pushError && <p style={{ color: '#EF4444', fontSize: 12, marginTop: 8 }}>{pushError}</p>}
        </div>

        <div style={{ marginBottom: 16 }}>
          <NotifToggle label="New orders" checked={notifs.newOrder} onChange={v => setNotifs({ ...notifs, newOrder: v })} />
          <NotifToggle label="Low / out of stock alerts" checked={notifs.lowStock} onChange={v => setNotifs({ ...notifs, lowStock: v })} />
          <NotifToggle label="New product reviews" checked={notifs.newReview} onChange={v => setNotifs({ ...notifs, newReview: v })} />
          <NotifToggle label="Staff member joined" checked={notifs.staffJoined} onChange={v => setNotifs({ ...notifs, staffJoined: v })} />
        </div>
        {saved && (
          <div style={{ background: C.greenLight, color: C.green, borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <CheckCircle2 size={16} /> Saved
          </div>
        )}
        <button disabled={saving} onClick={handleSaveNotifs} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 15, fontSize: 15, fontWeight: 700, cursor: 'pointer', width: '100%', marginBottom: 28, opacity: saving ? 0.7 : 1 }}>
          {saving ? 'Saving...' : 'Save Notification Preferences'}
        </button>

        <p style={{ fontSize: 12, fontWeight: 800, color: C.gray, textTransform: 'uppercase' as const, letterSpacing: 0.6, marginBottom: 10 }}>Danger Zone</p>
        <div style={{ border: `1.5px solid #FEE2E2`, background: '#FEF2F2', borderRadius: 14, padding: 16, marginBottom: 20 }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: '#B91C1C', marginBottom: 4 }}>Delete Account</p>
          <p style={{ fontSize: 12.5, color: '#7F1D1D', lineHeight: 1.5 }}>
            This permanently removes your store, products, and order history. Since this can't be
            undone, contact support first so we can help make sure you don't lose anything you
            need.
          </p>
        </div>

        <p style={{ fontSize: 11.5, color: C.gray, textAlign: 'center' as const }}>SalesPilot v1.0</p>
      </div>
    </div>
  );
}

// Real, direct ways to get help, plus quick answers to the questions merchants actually ask -
// and a link back to the in-app "How to Use SalesPilot" guide instead of repeating it here.
function HelpSupportScreen({ onBack, onNavigate }: { onBack: () => void; onNavigate: (action: string) => void }) {
  const faqs = [
    { q: 'How do I get paid?', a: 'Customers pay you directly by bank transfer to the account you set up under More, then Complete Your Store. There is no platform fee taken out, you get exactly what the customer paid. Once a customer confirms they have sent payment, check your bank account, then mark the order as Completed once you have confirmed it arrived.' },
    { q: 'Why isn\'t my store loading for a customer?', a: 'Double check your store link is correct, and that you have at least one product added. If it still isn\'t working, contact support with your store link.' },
    { q: 'How do I add my first product?', a: 'Go to Products, then tap Add Product. Add a name, price, and at least one photo to get started.' },
    { q: 'How do I know if a customer paid?', a: 'Check Orders, orders marked Completed have been paid successfully through Paystack.' },
    { q: 'Can I change my plan later?', a: 'Yes, go to More, then tap Upgrade Your Account at any time to switch plans or billing.' },
  ];
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>Help & Support</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>

        <p style={{ fontSize: 12, fontWeight: 800, color: C.gray, textTransform: 'uppercase' as const, letterSpacing: 0.6, marginBottom: 10 }}>Contact Us</p>
        {SUPPORT_EMAIL ? (
          <a href={`mailto:${SUPPORT_EMAIL}`} style={{ display: 'flex', alignItems: 'center', gap: 14, border: `1.5px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 24, textDecoration: 'none' }}>
            <div style={{ width: 44, height: 44, background: C.blueLight, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Mail size={19} color={C.blue} />
            </div>
            <div>
              <p style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>Email Support</p>
              <p style={{ fontSize: 12.5, color: C.gray }}>{SUPPORT_EMAIL}</p>
            </div>
          </a>
        ) : (
          <div style={{ border: `1.5px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 24 }}>
            <p style={{ fontSize: 13, color: C.gray }}>Support contact details are being set up. Check back soon.</p>
          </div>
        )}

        <p style={{ fontSize: 12, fontWeight: 800, color: C.gray, textTransform: 'uppercase' as const, letterSpacing: 0.6, marginBottom: 10 }}>Common Questions</p>
        {faqs.map((faq, i) => (
          <div key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
            <button onClick={() => setOpenFaq(openFaq === i ? null : i)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', border: 'none', padding: '14px 0', cursor: 'pointer', textAlign: 'left' as const }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: C.dark, flex: 1 }}>{faq.q}</span>
              <ChevronDown size={16} color={C.gray} style={{ transform: openFaq === i ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease', flexShrink: 0 }} />
            </button>
            {openFaq === i && (
              <p style={{ fontSize: 13, color: C.gray, lineHeight: 1.5, paddingBottom: 14 }}>{faq.a}</p>
            )}
          </div>
        ))}

        <button onClick={() => onNavigate('dashboard')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: C.bg, border: 'none', borderRadius: 14, padding: 16, cursor: 'pointer', marginTop: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <BookOpen size={19} color={C.navy} />
            <span style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>How to Use SalesPilot</span>
          </div>
          <ChevronRight size={18} color={C.gray} />
        </button>
      </div>
    </div>
  );
}

function CompleteStoreScreen({ onBack }: { onBack: () => void }) {
  const { user, updateProfile } = useAuth();
  const [activeItem, setActiveItem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [bankName, setBankName] = useState(user?.bankName || '');
  const [bankCode, setBankCode] = useState(user?.bankCode || '');
  const [accountNumber, setAccountNumber] = useState(user?.accountNumber || '');
  const [accountName, setAccountName] = useState(user?.accountName || '');
  const [banksList, setBanksList] = useState<{ name: string; code: string }[]>([]);
  const [loadingBanks, setLoadingBanks] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolvedName, setResolvedName] = useState('');
  const [resolveError, setResolveError] = useState('');
  const [savingBank, setSavingBank] = useState(false);
  const [state, setState] = useState(user?.state || '');
  const [zipcode, setZipcode] = useState(user?.zipcode || '');
  const [contactWhatsapp, setContactWhatsapp] = useState(user?.contactWhatsapp || user?.phone || '');
  const [contactEmail, setContactEmail] = useState(user?.contactEmail || user?.email || '');
  const [storeAddress, setStoreAddress] = useState(user?.storeAddress || '');
  const [storeDescription, setStoreDescription] = useState(user?.storeDescription || '');
  const [logoUrl, setLogoUrl] = useState(user?.logoUrl || '');
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [coverImageUrl, setCoverImageUrl] = useState(user?.coverImageUrl || '');
  const [uploadingCoverImage, setUploadingCoverImage] = useState(false);

  const inp = { width: '100%', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 15, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };
  const label = { fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 };

  const items = [
    { id: 'bank', Icon: Landmark, label: 'Bank details', sub: 'Add this to receive payments', done: !!(bankName && accountNumber && accountName), important: true },
    { id: 'location', Icon: MapPin, label: 'State & area', sub: 'Shown in your store footer', done: !!(state && zipcode), important: false },
    { id: 'contact', Icon: Phone, label: 'Contact info', sub: 'How customers reach you', done: !!(contactWhatsapp && contactEmail), important: false },
    { id: 'description', Icon: FileText, label: 'Store description', sub: 'Tell customers about your store', done: !!storeDescription, important: false },
    { id: 'logo', Icon: ImageIcon, label: 'Store logo', sub: 'Optional, but looks professional', done: !!logoUrl, important: false },
    { id: 'coverImage', Icon: ImageIcon, label: 'Cover photo', sub: 'A wide banner photo for your storefront home page', done: !!coverImageUrl, important: false },
  ];
  const completedCount = items.filter(i => i.done).length;

  const saveField = async (data: any) => {
    setError('');
    setSaving(true);
    try {
      await updateProfile(data);
      setActiveItem(null);
    } catch (err: any) {
      setError(err?.message || 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // Fetches the real, live list of Nigerian banks (with correct codes) from Paystack, the first
  // time the merchant opens the bank details screen.
  useEffect(() => {
    if (activeItem !== 'bank' || banksList.length > 0) return;
    setLoadingBanks(true);
    fetch('https://sales-pilot-payment.vercel.app/api/list-banks')
      .then(res => res.json())
      .then(data => setBanksList(data.banks || []))
      .catch(() => setError('Could not load the bank list. Please check your connection.'))
      .finally(() => setLoadingBanks(false));
  }, [activeItem]);

  // Verifies the account number actually belongs to a real account before anything is saved -
  // shows the real account name back to the merchant so they can catch a typo themselves.
  const verifyAccount = async () => {
    setResolveError('');
    setResolvedName('');
    if (!bankCode || accountNumber.length !== 10) return;
    setResolving(true);
    try {
      const res = await fetch('https://sales-pilot-payment.vercel.app/api/resolve-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountNumber, bankCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResolveError(extractErrorMessage(data) || 'Could not verify this account.');
        return;
      }
      setResolvedName(data.accountName);
      setAccountName(data.accountName);
    } catch {
      setResolveError('Could not verify this account. Please check your connection.');
    } finally {
      setResolving(false);
    }
  };

  useEffect(() => {
    if (accountNumber.length === 10 && bankCode) {
      const t = setTimeout(verifyAccount, 500);
      return () => clearTimeout(t);
    } else {
      setResolvedName('');
    }
  }, [accountNumber, bankCode]);

  // Once the account is verified against a real name, just saves it directly - this is what
  // gets shown to customers at checkout so they know exactly where to send their payment.
  const handleSaveBankDetails = async () => {
    setError('');
    if (!bankCode || !accountNumber || !resolvedName) {
      setError('Please select your bank, enter your account number, and wait for it to verify before saving.');
      return;
    }
    setSavingBank(true);
    try {
      await updateProfile({ bankName, bankCode, accountNumber, accountName: resolvedName });
      setActiveItem(null);
    } catch {
      setError('Could not save your bank details. Please check your connection and try again.');
    } finally {
      setSavingBank(false);
    }
  };

  const handleLogoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user?.uid) return;
    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file.');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError('Logo image is too large. Please choose one under 4MB.');
      return;
    }
    setError('');
    setUploadingLogo(true);
    try {
      const compressed = await compressImage(file, 512, 0.85);
      const url = await uploadToCloudinary(compressed, `logos/${user.uid}`);
      setLogoUrl(url);
    } catch (err: any) {
      setError(err?.message || 'Logo upload failed. Check your connection and try again.');
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleCoverImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user?.uid) return;
    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file.');
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      setError('Cover photo is too large. Please choose one under 6MB.');
      return;
    }
    setError('');
    setUploadingCoverImage(true);
    try {
      const compressed = await compressImage(file, 1400, 0.8);
      const url = await uploadToCloudinary(compressed, `covers/${user.uid}`);
      setCoverImageUrl(url);
    } catch (err: any) {
      setError(err?.message || 'Cover photo upload failed. Check your connection and try again.');
    } finally {
      setUploadingCoverImage(false);
    }
  };

  if (activeItem === 'bank') {
    return (
      <ChecklistItemScreen title="Bank details" onBack={() => setActiveItem(null)} saving={savingBank} error={error}
        onSave={handleSaveBankDetails}>
        <div>
          <label style={label}>Bank</label>
          <select
            style={{ ...inp, appearance: 'none' } as any}
            value={bankCode}
            onChange={e => {
              const selected = banksList.find(b => b.code === e.target.value);
              setBankCode(e.target.value);
              setBankName(selected?.name || '');
            }}
            disabled={loadingBanks}
          >
            <option value="">{loadingBanks ? 'Loading banks...' : 'Select your bank'}</option>
            {banksList.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label style={label}>Account number</label>
          <input style={inp} placeholder="0123456789" value={accountNumber} onChange={e => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 10))} />
        </div>
        {resolving && <p style={{ fontSize: 12.5, color: C.gray }}>Verifying account...</p>}
        {resolveError && <p style={{ fontSize: 12.5, color: '#EF4444' }}>{resolveError}</p>}
        {resolvedName && !resolving && (
          <div style={{ background: C.greenLight, borderRadius: 12, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <CheckCircle2 size={16} color={C.green} />
            <div>
              <p style={{ fontSize: 12, color: C.green, fontWeight: 700 }}>Account verified</p>
              <p style={{ fontSize: 13, color: C.dark, fontWeight: 600 }}>{resolvedName}</p>
            </div>
          </div>
        )}
        <p style={{ fontSize: 12, color: C.gray }}>
          This is the account customers will pay directly, every order comes straight to you, in
          full, with no platform fee taken out.
        </p>
      </ChecklistItemScreen>
    );
  }

  if (activeItem === 'location') {
    return (
      <ChecklistItemScreen title="State & area" onBack={() => setActiveItem(null)} saving={saving} error={error}
        onSave={() => saveField({ state, zipcode })}>
        <div>
          <label style={label}>State</label>
          <select style={{ ...inp, appearance: 'none' } as any} value={state} onChange={e => setState(e.target.value)}>
            <option value="">Select your state</option>
            {NIGERIAN_STATES.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label style={label}>Area / Zipcode</label>
          <input style={inp} placeholder="e.g. Ikeja, 100001" value={zipcode} onChange={e => setZipcode(e.target.value)} />
        </div>
        <p style={{ fontSize: 12, color: C.gray }}>This helps customers know where you ship from and builds trust in your store.</p>
      </ChecklistItemScreen>
    );
  }

  if (activeItem === 'contact') {
    return (
      <ChecklistItemScreen title="Contact info" onBack={() => setActiveItem(null)} saving={saving} error={error}
        onSave={() => saveField({ contactWhatsapp, contactEmail, storeAddress })}>
        <div>
          <label style={label}>WhatsApp number</label>
          <input style={inp} placeholder="08012345678" value={contactWhatsapp} onChange={e => setContactWhatsapp(e.target.value)} />
        </div>
        <div>
          <label style={label}>Email address</label>
          <input style={inp} type="email" placeholder="you@example.com" value={contactEmail} onChange={e => setContactEmail(e.target.value)} />
        </div>
        <div>
          <label style={label}>Store address (optional)</label>
          <textarea style={{ ...inp, minHeight: 70, resize: 'vertical' as const, fontFamily: 'inherit' }} placeholder="e.g. Shop 4, Alagbole Market, Akute, Ogun State" value={storeAddress} onChange={e => setStoreAddress(e.target.value)} />
        </div>
        <p style={{ fontSize: 12, color: C.gray }}>Customers will use these to reach you with questions about their orders. Your address shows in your storefront footer.</p>
      </ChecklistItemScreen>
    );
  }

  if (activeItem === 'description') {
    return (
      <ChecklistItemScreen title="Store description" onBack={() => setActiveItem(null)} saving={saving} error={error}
        onSave={() => saveField({ storeDescription })}>
        <div>
          <label style={label}>About your store</label>
          <textarea
            style={{ ...inp, resize: 'vertical' as const, minHeight: 110, fontFamily: 'inherit', wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const }}
            placeholder="Tell customers what you sell and what makes your store special..."
            value={storeDescription}
            onChange={e => setStoreDescription(e.target.value)}
            maxLength={500}
          />
          <p style={{ fontSize: 11, color: C.gray, marginTop: 4, textAlign: 'right' as const }}>{storeDescription.length}/500</p>
        </div>
      </ChecklistItemScreen>
    );
  }

  if (activeItem === 'logo') {
    return (
      <ChecklistItemScreen title="Store logo" onBack={() => setActiveItem(null)} saving={saving} error={error}
        onSave={() => saveField({ logoUrl: logoUrl || undefined })}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 14 }}>
          <div style={{ width: 100, height: 100, borderRadius: 20, background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', position: 'relative' as const }}>
            {logoUrl ? <img src={logoUrl} alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'cover' as const }} /> : <ImageIcon size={36} color={C.gray} />}
            {uploadingLogo && (
              <div style={{ position: 'absolute' as const, inset: 0, background: 'rgba(255,255,255,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: 22, height: 22, border: `2.5px solid ${C.border}`, borderTopColor: C.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              </div>
            )}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: '12px 20px', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: C.navy }}>
            <Camera size={16} />
            {logoUrl ? 'Change logo' : 'Upload logo'}
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleLogoSelect} />
          </label>
        </div>
        <p style={{ fontSize: 12, color: C.gray, textAlign: 'center' as const }}>This is fully optional, but it makes your store look more professional and recognizable.</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </ChecklistItemScreen>
    );
  }

  if (activeItem === 'coverImage') {
    return (
      <ChecklistItemScreen title="Cover photo" onBack={() => setActiveItem(null)} saving={saving} error={error}
        onSave={() => saveField({ coverImageUrl: coverImageUrl || undefined })}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 14 }}>
          <div style={{ width: '100%', aspectRatio: '2.4', borderRadius: 16, background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', position: 'relative' as const }}>
            {coverImageUrl ? <img src={coverImageUrl} alt="Cover" style={{ width: '100%', height: '100%', objectFit: 'cover' as const }} /> : <ImageIcon size={36} color={C.gray} />}
            {uploadingCoverImage && (
              <div style={{ position: 'absolute' as const, inset: 0, background: 'rgba(255,255,255,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ width: 22, height: 22, border: `2.5px solid ${C.border}`, borderTopColor: C.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              </div>
            )}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: '12px 20px', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: C.navy }}>
            <Camera size={16} />
            {coverImageUrl ? 'Change cover photo' : 'Upload cover photo'}
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleCoverImageSelect} />
          </label>
          {coverImageUrl && (
            <button onClick={() => setCoverImageUrl('')} style={{ background: 'none', border: 'none', color: '#EF4444', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Remove photo</button>
          )}
        </div>
        <p style={{ fontSize: 12, color: C.gray, textAlign: 'center' as const }}>A wide photo shown at the top of your storefront home page. Optional, if you don't add one, your store just shows your name and description instead.</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </ChecklistItemScreen>
    );
  }

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 32px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 22, fontWeight: 700 }}>Complete your store</h2>
      </div>
      <div style={{ padding: '0 16px', marginTop: -16 }}>
        <div style={{ background: C.white, borderRadius: 16, padding: 16, marginBottom: 16, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: C.dark }}>{completedCount} of {items.length} completed</p>
            <p style={{ fontSize: 13, fontWeight: 700, color: C.green }}>{Math.round((completedCount / items.length) * 100)}%</p>
          </div>
          <div style={{ height: 8, background: C.bg, borderRadius: 20, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(completedCount / items.length) * 100}%`, background: C.green, borderRadius: 20, transition: 'width 0.3s' }} />
          </div>
        </div>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', padding: 20 }}>
        {items.map(item => (
          <div key={item.id} onClick={() => setActiveItem(item.id)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}>
            <div style={{ width: 46, height: 46, background: item.done ? C.greenLight : C.bg, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {item.done ? <CheckCircle2 size={20} color={C.green} /> : <item.Icon size={20} color={C.gray} />}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <p style={{ fontSize: 15, fontWeight: 600, color: C.dark }}>{item.label}</p>
                {item.important && !item.done && (
                  <span style={{ background: C.orangeLight, color: C.orange, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>Important</span>
                )}
              </div>
              <p style={{ fontSize: 12, color: C.gray }}>{item.sub}</p>
            </div>
            <ChevronRight size={18} color={C.gray} />
          </div>
        ))}
      </div>
    </div>
  );
}

type ReportPeriod = '7days' | '30days' | 'thismonth' | 'alltime';

function StorefrontMockup({ theme }: { theme: StoreTheme }) {
  return (
    <div style={{ background: theme.background, borderRadius: 12, overflow: 'hidden', border: `1px solid ${C.border}`, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: theme.primary, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: '#fff', fontWeight: 800, fontSize: 14 }}>My Store</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <ShoppingBag size={14} color="#fff" />
          <Search size={14} color="#fff" />
        </div>
      </div>
      <div style={{ background: `linear-gradient(135deg, ${theme.primary}, ${theme.secondary})`, padding: '14px', textAlign: 'center' as const }}>
        <p style={{ color: '#fff', fontWeight: 700, fontSize: 11, marginBottom: 4 }}>Welcome to our store</p>
        <p style={{ color: 'rgba(255,255,255,0.8)', fontSize: 10, marginBottom: 8 }}>Discover our latest products</p>
        <button style={{ background: theme.accent, color: theme.primary, border: 'none', borderRadius: 20, padding: '5px 14px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>Shop Now</button>
      </div>
      <div style={{ padding: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {['Product One', 'Product Two'].map((name, i) => (
          <div key={i} style={{ background: theme.accent, borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ background: `${theme.primary}22`, height: 52, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Shirt size={20} color={theme.primary} />
            </div>
            <div style={{ padding: '6px 8px' }}>
              <p style={{ fontSize: 10, fontWeight: 600, color: theme.secondary, marginBottom: 3 }}>{name}</p>
              <p style={{ fontSize: 10, fontWeight: 800, color: theme.primary, marginBottom: 6 }}>{NAIRA}12,000</p>
              <button style={{ background: theme.primary, color: '#fff', border: 'none', borderRadius: 6, padding: '4px 0', fontSize: 9, fontWeight: 700, width: '100%', cursor: 'pointer' }}>Add to cart</button>
            </div>
          </div>
        ))}
      </div>
      <div style={{ background: theme.background, borderTop: `1px solid ${theme.accent}`, padding: '6px 0', display: 'flex', justifyContent: 'space-around' }}>
        {[Home, Package, ShoppingBag, Users].map((Icon, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 2 }}>
            <Icon size={12} color={i === 0 ? theme.primary : theme.secondary} />
            <div style={{ width: 3, height: 3, borderRadius: '50%', background: i === 0 ? theme.primary : 'transparent' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function BrandStudioScreen({ onBack }: { onBack: () => void }) {
  const { user, updateProfile } = useAuth();
  const isPro = isProAccess(user);
  const [selectedNiche, setSelectedNiche] = useState<string>(THEME_NICHES[0].id);
  const [previewTheme, setPreviewTheme] = useState<StoreTheme | null>(null);
  const [appliedThemeId, setAppliedThemeId] = useState<string>(user?.themeId || 'fresh-market');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const currentNiche = THEME_NICHES.find(n => n.id === selectedNiche) || THEME_NICHES[0];
  const displayTheme = previewTheme || (
    THEME_NICHES.flatMap(n => n.themes).find(t => t.id === appliedThemeId) || THEME_NICHES[0].themes[0]
  );

  const handleApply = async () => {
    if (!previewTheme) return;
    setSaving(true);
    setError('');
    try {
      await updateProfile({ themeId: previewTheme.id, themeName: previewTheme.name });
      setAppliedThemeId(previewTheme.id);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      setError('Could not save theme. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 120, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <div>
          <h2 style={{ color: 'white', fontSize: 20, fontWeight: 700 }}>Brand Studio</h2>
          <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>Customize your storefront look</p>
        </div>
      </div>

      <div style={{ padding: '0 16px', marginTop: -16 }}>
        <div style={{ background: C.white, borderRadius: 20, padding: 16, marginBottom: 16, boxShadow: '0 4px 20px rgba(0,0,0,0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: C.dark }}>Live preview</p>
            <span style={{ fontSize: 11, fontWeight: 600, color: C.gray, background: C.bg, padding: '3px 10px', borderRadius: 20 }}>{displayTheme.name}</span>
          </div>
          <StorefrontMockup theme={displayTheme} />
          {previewTheme && previewTheme.id !== appliedThemeId && (
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <button onClick={() => setPreviewTheme(null)} style={{ flex: 1, background: C.bg, border: 'none', borderRadius: 12, padding: 12, fontSize: 13, fontWeight: 600, color: C.gray, cursor: 'pointer' }}>Cancel</button>
              <button disabled={saving} onClick={handleApply} style={{ flex: 2, background: displayTheme.primary, color: '#fff', border: 'none', borderRadius: 12, padding: 12, fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
                {saving ? 'Applying...' : 'Apply this theme'}
              </button>
            </div>
          )}
          {saved && (
            <div style={{ marginTop: 10, background: C.greenLight, color: C.green, borderRadius: 10, padding: '8px 12px', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
              <CheckCircle2 size={14} /> Theme applied to your store
            </div>
          )}
          {error && (
            <div style={{ marginTop: 10, background: '#FEE2E2', color: '#EF4444', borderRadius: 10, padding: '8px 12px', fontSize: 12, fontWeight: 600 }}>{error}</div>
          )}
        </div>

        <div style={{ marginBottom: 14 }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: C.dark, marginBottom: 10 }}>Select your niche</p>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto' as const, paddingBottom: 4 }}>
            {THEME_NICHES.map(niche => (
              <button key={niche.id} onClick={() => setSelectedNiche(niche.id)} style={{ whiteSpace: 'nowrap' as const, padding: '8px 14px', borderRadius: 20, border: `1.5px solid ${selectedNiche === niche.id ? C.navy : C.border}`, background: selectedNiche === niche.id ? C.navy : C.white, color: selectedNiche === niche.id ? 'white' : C.gray, fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>
                {niche.name}
              </button>
            ))}
          </div>
        </div>

        <p style={{ fontSize: 13, fontWeight: 700, color: C.dark, marginBottom: 10 }}>{currentNiche.name} themes</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {currentNiche.themes.map(theme => {
            const isLocked = theme.proOnly && !isPro;
            const isApplied = theme.id === appliedThemeId;
            const isPreviewing = previewTheme?.id === theme.id;
            return (
              <div key={theme.id} onClick={() => { if (!isLocked) setPreviewTheme(theme); }} style={{ background: C.white, borderRadius: 16, overflow: 'hidden', cursor: isLocked ? 'not-allowed' : 'pointer', border: `2px solid ${isPreviewing || isApplied ? theme.primary : C.border}`, opacity: isLocked ? 0.6 : 1, boxShadow: isPreviewing ? `0 0 0 2px ${theme.primary}44` : '0 2px 8px rgba(0,0,0,0.06)' }}>
                <div style={{ height: 64, background: `linear-gradient(135deg, ${theme.primary} 0%, ${theme.secondary} 60%, ${theme.accent} 100%)`, position: 'relative' as const }}>
                  {isApplied && (
                    <div style={{ position: 'absolute' as const, top: 6, right: 6, background: '#fff', borderRadius: '50%', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <CheckCircle2 size={14} color={theme.primary} />
                    </div>
                  )}
                  {isLocked && (
                    <div style={{ position: 'absolute' as const, top: 6, right: 6, background: 'rgba(0,0,0,0.5)', borderRadius: 20, padding: '2px 7px' }}>
                      <span style={{ color: '#fff', fontSize: 9, fontWeight: 700 }}>PRO</span>
                    </div>
                  )}
                </div>
                <div style={{ padding: '8px 10px' }}>
                  <p style={{ fontSize: 12, fontWeight: 700, color: C.dark, marginBottom: 6 }}>{theme.name}</p>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {[theme.primary, theme.secondary, theme.accent].map((color, i) => (
                      <div key={i} style={{ width: 14, height: 14, borderRadius: '50%', background: color, border: '1px solid rgba(0,0,0,0.08)' }} />
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {!isPro && (
          <div style={{ background: C.navyLight, borderRadius: 14, padding: '14px 16px', marginTop: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
            <Sparkles size={20} color="#D4AF37" />
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 2 }}>Unlock all themes with Pro</p>
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>32 premium themes across all niches</p>
            </div>
            <button style={{ background: '#D4AF37', color: '#111', border: 'none', borderRadius: 10, padding: '8px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}>Upgrade</button>
          </div>
        )}
      </div>
    </div>
  );
}
function AnalyticsScreen({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const isPro = isProAccess(user);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [posSales, setPosSales] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [dailyVisits, setDailyVisits] = useState<{ [date: string]: number }>({});
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'Today' | 'This Week' | 'This Month' | 'All Time'>('This Month');

  useEffect(() => {
    if (!user?.uid) return;
    const unsubProducts = onSnapshot(collection(db, 'merchants', user.uid, 'products'), (snap) => {
      setProducts(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).filter((p: any) => !p._deleted));
    });
    const unsubOrders = onSnapshot(collection(db, 'merchants', user.uid, 'orders'), (snap) => {
      setOrders(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })));
      setLoading(false);
    }, () => setLoading(false));
    const unsubPOS = onSnapshot(collection(db, 'merchants', user.uid, 'pos_sales'), (snap) => {
      setPosSales(snap.docs.map(d => d.data() as any).filter(s => !s._deleted));
    });
    const unsubInvoices = onSnapshot(collection(db, 'merchants', user.uid, 'invoices'), (snap) => {
      setInvoices(snap.docs.map(d => d.data() as any).filter(i => !i._deleted));
    });
    const unsubExpenses = onSnapshot(collection(db, 'merchants', user.uid, 'expenses'), (snap) => {
      setExpenses(snap.docs.map(d => d.data() as any).filter(e => !e._deleted));
    });
    const unsubVisits = onSnapshot(collection(db, 'merchants', user.uid, 'analytics'), (snap) => {
      const visits: { [date: string]: number } = {};
      snap.docs.forEach(d => { visits[d.id] = (d.data() as any).visits || 0; });
      setDailyVisits(visits);
    });
    return () => { unsubProducts(); unsubOrders(); unsubPOS(); unsubInvoices(); unsubExpenses(); unsubVisits(); };
  }, [user?.uid]);

  const inPeriod = (dateStr: string | undefined): boolean => {
    if (!dateStr) return false;
    if (period === 'All Time') return true;
    const d = dateStr.slice(0, 10);
    const now = new Date();
    if (period === 'Today') return d === now.toISOString().slice(0, 10);
    if (period === 'This Week') return d >= new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return d.slice(0, 7) === now.toISOString().slice(0, 7);
  };

  const periodOrders = orders.filter(o => inPeriod(o.createdAt) && o.status !== 'Cancelled' && o.status !== 'Pending');
  const periodPOS = posSales.filter(s => inPeriod(s.date));
  const periodInvoices = invoices.filter(i => i.paid && inPeriod(i.date));
  const periodExpenses = expenses.filter(e => inPeriod(e.date)).reduce((s, e) => s + (e.amount || 0), 0);

  const onlineRevenue = periodOrders.reduce((s, o) => s + (o.total || 0), 0);
  const offlineRevenue = periodPOS.reduce((s, sale) => s + (sale.total || 0), 0) + periodInvoices.reduce((s, inv) => s + (inv.items || []).reduce((x: number, it: any) => x + it.quantity * it.unitPrice, 0), 0);
  const totalRevenue = onlineRevenue + offlineRevenue;
  // "Net profit" here means total revenue minus real running costs (expenses) - it does not
  // subtract cost-of-goods, since SalesPilot doesn't currently track a per-product cost price,
  // only a sale price. A true "gross profit" figure would need that cost data added first.
  const netProfit = totalRevenue - periodExpenses;
  // Coupon discounts only apply to online storefront checkout right now - POS sales and
  // Invoices don't have a discount concept in the app yet, so this only reflects online orders.
  const discountGiven = periodOrders.reduce((s, o) => s + (o.discount || 0), 0);

  // Aggregate units sold per product across all three sale sources
  const productStats: { [key: string]: { name: string; qty: number; revenue: number } } = {};
  const bump = (key: string, name: string, qty: number, revenue: number) => {
    if (!productStats[key]) productStats[key] = { name, qty: 0, revenue: 0 };
    productStats[key].qty += qty;
    productStats[key].revenue += revenue;
  };
  periodOrders.forEach(o => (o.items || []).forEach((it: any) => bump(it.productId || it.name, it.name, it.quantity, it.price * it.quantity)));
  periodPOS.forEach(s => (s.items || []).forEach((it: any) => bump(it.productId || it.description, it.description, it.quantity, it.unitPrice * it.quantity)));
  periodInvoices.forEach(inv => (inv.items || []).forEach((it: any) => bump(it.productId || it.description, it.description, it.quantity, it.unitPrice * it.quantity)));

  const bestSellers = Object.values(productStats).sort((a, b) => b.qty - a.qty).slice(0, 5);
  const soldProductKeys = new Set(Object.keys(productStats));
  const noMovers = products.filter(p => !soldProductKeys.has(p.id)).slice(0, 5);

  // Unique customers who bought in this period, and their combined spend
  const customerSpend: { [key: string]: number } = {};
  periodOrders.forEach(o => { const k = o.customerName?.trim().toLowerCase(); if (k) customerSpend[k] = (customerSpend[k] || 0) + (o.total || 0); });
  periodPOS.forEach(s => { const k = s.customerName?.trim().toLowerCase(); if (k) customerSpend[k] = (customerSpend[k] || 0) + (s.total || 0); });
  periodInvoices.forEach(inv => { const k = inv.customerName?.trim().toLowerCase(); const t = (inv.items || []).reduce((x: number, it: any) => x + it.quantity * it.unitPrice, 0); if (k) customerSpend[k] = (customerSpend[k] || 0) + t; });
  const customerCount = Object.keys(customerSpend).length;
  const avgSpend = customerCount > 0 ? totalRevenue / customerCount : 0;

  // Total website visits in the selected period, from the lightweight daily counters
  // Storefront.tsx logs once per visitor per day.
  const periodVisits = Object.entries(dailyVisits)
    .filter(([date]) => inPeriod(date))
    .reduce((sum, [, count]) => sum + count, 0);

  // How much revenue came from each marketing channel (WhatsApp, Instagram, Twitter, etc.) -
  // based on the referrer/link tag detected when the customer first landed on the storefront.
  const channelRevenue: { [channel: string]: number } = {};
  periodOrders.forEach(o => {
    const ch = o.source || 'Direct';
    channelRevenue[ch] = (channelRevenue[ch] || 0) + (o.total || 0);
  });
  const channelEntries = Object.entries(channelRevenue).sort((a, b) => b[1] - a[1]);
  const maxChannelAmount = Math.max(...channelEntries.map(([, v]) => v), 1);

  const periods: typeof period[] = ['Today', 'This Week', 'This Month', 'All Time'];
  const maxChannelRevenue = Math.max(onlineRevenue, offlineRevenue, 1);

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 32px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><ArrowLeft size={18} color="white" /></button>
        <h2 style={{ color: 'white', fontSize: 22, fontWeight: 700 }}>Analytics</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20 }}>
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto' as const, paddingBottom: 4, marginBottom: 18 }}>
          {periods.map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={{ background: period === p ? C.navy : C.bg, color: period === p ? 'white' : C.gray, border: 'none', borderRadius: 20, padding: '8px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const }}>{p}</button>
          ))}
        </div>

        {loading ? (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray }}>Loading analytics...</div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
              <div style={{ background: C.greenLight, borderRadius: 14, padding: 14 }}>
                <p style={{ fontSize: 11.5, color: C.green, fontWeight: 700, marginBottom: 4 }}>Total Sales</p>
                <p style={{ fontSize: 18, fontWeight: 800, color: C.dark }}>{NAIRA}{totalRevenue.toLocaleString()}</p>
              </div>
              <div style={{ background: C.blueLight, borderRadius: 14, padding: 14 }}>
                <p style={{ fontSize: 11.5, color: C.blue, fontWeight: 700, marginBottom: 4 }}>Net Profit</p>
                <p style={{ fontSize: 18, fontWeight: 800, color: C.dark }}>{NAIRA}{netProfit.toLocaleString()}</p>
              </div>
              <div style={{ background: '#FEE2E2', borderRadius: 14, padding: 14 }}>
                <p style={{ fontSize: 11.5, color: '#EF4444', fontWeight: 700, marginBottom: 4 }}>Expenses</p>
                <p style={{ fontSize: 18, fontWeight: 800, color: C.dark }}>{NAIRA}{periodExpenses.toLocaleString()}</p>
              </div>
              <div style={{ background: '#CCFBF1', borderRadius: 14, padding: 14 }}>
                <p style={{ fontSize: 11.5, color: '#0D9488', fontWeight: 700, marginBottom: 4 }}>Discount Given</p>
                <p style={{ fontSize: 18, fontWeight: 800, color: C.dark }}>{NAIRA}{discountGiven.toLocaleString()}</p>
              </div>
              <div style={{ background: C.purpleLight, borderRadius: 14, padding: 14 }}>
                <p style={{ fontSize: 11.5, color: C.purple, fontWeight: 700, marginBottom: 4 }}>Customers</p>
                <p style={{ fontSize: 18, fontWeight: 800, color: C.dark }}>{customerCount}</p>
              </div>
              <div style={{ background: C.orangeLight, borderRadius: 14, padding: 14 }}>
                <p style={{ fontSize: 11.5, color: C.orange, fontWeight: 700, marginBottom: 4 }}>Avg Spend/Customer</p>
                <p style={{ fontSize: 18, fontWeight: 800, color: C.dark }}>{NAIRA}{Math.round(avgSpend).toLocaleString()}</p>
              </div>
              {isPro ? (
                <div style={{ background: C.bg, borderRadius: 14, padding: 14 }}>
                  <p style={{ fontSize: 11.5, color: C.gray, fontWeight: 700, marginBottom: 4 }}>Website Visits</p>
                  <p style={{ fontSize: 18, fontWeight: 800, color: C.dark }}>{periodVisits.toLocaleString()}</p>
                </div>
              ) : (
                <div style={{ background: C.bg, borderRadius: 14, padding: 14, opacity: 0.6 }}>
                  <p style={{ fontSize: 11.5, color: C.gray, fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>Website Visits <Lock size={10} /></p>
                  <p style={{ fontSize: 13, fontWeight: 700, color: C.gray }}>Growth only</p>
                </div>
              )}
            </div>

            <p style={{ fontSize: 14, fontWeight: 700, color: C.dark, marginBottom: 12 }}>Online vs Offline</p>
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12.5, color: C.gray }}>Online (storefront)</span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: C.dark }}>{NAIRA}{onlineRevenue.toLocaleString()}</span>
              </div>
              <div style={{ background: C.bg, borderRadius: 6, height: 8, marginBottom: 14, overflow: 'hidden' }}>
                <div style={{ width: `${(onlineRevenue / maxChannelRevenue) * 100}%`, height: '100%', background: C.navy, borderRadius: 6 }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12.5, color: C.gray }}>Offline (POS + Invoices)</span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: C.dark }}>{NAIRA}{offlineRevenue.toLocaleString()}</span>
              </div>
              <div style={{ background: C.bg, borderRadius: 6, height: 8, overflow: 'hidden' }}>
                <div style={{ width: `${(offlineRevenue / maxChannelRevenue) * 100}%`, height: '100%', background: C.green, borderRadius: 6 }} />
              </div>
            </div>

            <p style={{ fontSize: 14, fontWeight: 700, color: C.dark, marginBottom: 12 }}>Sales by Marketing Channel</p>
            {!isPro ? (
              <div style={{ background: C.bg, borderRadius: 14, padding: 20, marginBottom: 24, textAlign: 'center' as const }}>
                <Lock size={20} color={C.gray} style={{ marginBottom: 8 }} />
                <p style={{ fontSize: 13, color: C.gray, lineHeight: 1.5 }}>See exactly where your customers are coming from - WhatsApp, Instagram, and more. This is a Growth plan feature.</p>
              </div>
            ) : channelEntries.length === 0 ? (
              <p style={{ fontSize: 13, color: C.gray, marginBottom: 24 }}>No online orders recorded in this period yet.</p>
            ) : (
              <div style={{ marginBottom: 24 }}>
                {channelEntries.map(([channel, amount]) => (
                  <div key={channel} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 12.5, color: C.gray }}>{channel}</span>
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: C.dark }}>{NAIRA}{amount.toLocaleString()}</span>
                    </div>
                    <div style={{ background: C.bg, borderRadius: 6, height: 8, overflow: 'hidden' }}>
                      <div style={{ width: `${(amount / maxChannelAmount) * 100}%`, height: '100%', background: C.purple, borderRadius: 6 }} />
                    </div>
                  </div>
                ))}
              </div>
            )}

            <p style={{ fontSize: 14, fontWeight: 700, color: C.dark, marginBottom: 12 }}>Best Sellers</p>
            {bestSellers.length === 0 ? (
              <p style={{ fontSize: 13, color: C.gray, marginBottom: 24 }}>No sales recorded in this period yet.</p>
            ) : (
              <div style={{ marginBottom: 24 }}>
                {bestSellers.map((p, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ width: 26, height: 26, borderRadius: 8, background: C.greenLight, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: C.green, flexShrink: 0 }}>{i + 1}</div>
                    <p style={{ fontSize: 13.5, color: C.dark, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>{p.name}</p>
                    <p style={{ fontSize: 12.5, color: C.gray }}>{p.qty} sold</p>
                  </div>
                ))}
              </div>
            )}

            <p style={{ fontSize: 14, fontWeight: 700, color: C.dark, marginBottom: 12 }}>Not Moving</p>
            {noMovers.length === 0 ? (
              <p style={{ fontSize: 13, color: C.gray }}>Every active product has sold at least once in this period.</p>
            ) : (
              <div>
                {noMovers.map(p => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ width: 26, height: 26, borderRadius: 8, background: '#FEE2E2', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><AlertTriangle size={13} color="#EF4444" /></div>
                    <p style={{ fontSize: 13.5, color: C.dark, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>{p.name}</p>
                    <p style={{ fontSize: 12.5, color: C.gray }}>0 sold</p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function EmailCampaignScreen({ onBack, onNavigate }: { onBack: () => void; onNavigate: (action: string) => void }) {
  const { user, updateProfile } = useAuth();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [posSales, setPosSales] = useState<any[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [segmentsMap, setSegmentsMap] = useState<{ [key: string]: string[] }>({});
  const [loading, setLoading] = useState(true);
  const [audience, setAudience] = useState('All Customers');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sendProgress, setSendProgress] = useState(0);
  const [sendResult, setSendResult] = useState<{ sent: number; total: number; errorDetail?: string } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    ensureCreditsRefreshed(user, updateProfile);
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid) return;
    let invLoaded = false, posLoaded = false, ordLoaded = false, segLoaded = false;
    const checkDone = () => { if (invLoaded && posLoaded && ordLoaded && segLoaded) setLoading(false); };
    const unsubInv = onSnapshot(collection(db, 'merchants', user.uid, 'invoices'), (snap) => {
      setInvoices(snap.docs.map(d => d.data() as any).filter(i => !i._deleted));
      invLoaded = true; checkDone();
    }, () => { invLoaded = true; checkDone(); });
    const unsubPos = onSnapshot(collection(db, 'merchants', user.uid, 'pos_sales'), (snap) => {
      setPosSales(snap.docs.map(d => d.data() as any).filter(s => !s._deleted));
      posLoaded = true; checkDone();
    }, () => { posLoaded = true; checkDone(); });
    const unsubOrd = onSnapshot(collection(db, 'merchants', user.uid, 'orders'), (snap) => {
      setOrders(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).filter((o: any) => o.status !== 'Cancelled'));
      ordLoaded = true; checkDone();
    }, () => { ordLoaded = true; checkDone(); });
    const unsubSeg = onSnapshot(collection(db, 'merchants', user.uid, 'customerSegments'), (snap) => {
      const map: { [key: string]: string[] } = {};
      snap.docs.forEach(d => { map[d.id] = (d.data() as any).segments || []; });
      setSegmentsMap(map);
      segLoaded = true; checkDone();
    }, () => { segLoaded = true; checkDone(); });
    return () => { unsubInv(); unsubPos(); unsubOrd(); unsubSeg(); };
  }, [user?.uid]);

  // Build a simple unique-customer-by-email list from all three sale sources
  const recipients = (() => {
    const map = new Map<string, { name: string; email: string; key: string }>();
    invoices.forEach(inv => { if (inv.customerEmail) map.set(inv.customerEmail.toLowerCase(), { name: inv.customerName || 'Customer', email: inv.customerEmail, key: normalizeName(inv.customerName || '') }); });
    posSales.forEach((s: any) => { if (s.customerEmail) map.set(s.customerEmail.toLowerCase(), { name: s.customerName || 'Customer', email: s.customerEmail, key: normalizeName(s.customerName || '') }); });
    orders.forEach(o => { if (o.customerEmail && o.status !== 'Pending') map.set(o.customerEmail.toLowerCase(), { name: o.customerName || 'Customer', email: o.customerEmail, key: normalizeName(o.customerName) }); });
    return Array.from(map.values());
  })();

  const allSegments = Array.from(new Set(Object.values(segmentsMap).flat())).sort();
  const filteredRecipients = audience === 'All Customers'
    ? recipients
    : recipients.filter(r => (segmentsMap[r.key] || []).includes(audience));

  const handleSend = async () => {
    setError('');
    if (!subject.trim() || !message.trim()) { setError('Please fill in both a subject and a message.'); return; }
    if (filteredRecipients.length === 0) { setError('No customers match this audience.'); return; }
    if (filteredRecipients.length > 100) { setError(`This audience has ${filteredRecipients.length} customers, but your email plan only allows 100 emails per day. Try a smaller group, or split this into batches over a few days.`); return; }
    const creditsNeeded = filteredRecipients.length * CREDITS_PER_EMAIL;
    const creditsAvailable = user?.messagingCredits ?? 0;
    if (creditsAvailable < creditsNeeded) {
      setError(`This campaign needs ${creditsNeeded} credits, but you only have ${creditsAvailable} left. Buy more credits to send to everyone in this audience.`);
      return;
    }
    setSending(true);
    setSendProgress(0);
    let sentCount = 0;
    let lastErrorDetail = '';
    for (const r of filteredRecipients) {
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#111827;">
          <p style="white-space:pre-wrap;">${message.replace(/\n/g, '<br/>')}</p>
          <p style="font-size:12px;color:#9CA3AF;margin-top:24px;">Sent by ${user?.storeName || 'our store'}</p>
        </div>
      `;
      try {
        const res = await fetch('https://sales-pilot-payment.vercel.app/api/send-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: r.email, subject: subject.trim(), html }),
        });
        if (res.ok) {
          sentCount++;
        } else {
          let detail = '';
          try { const body = await res.json(); detail = extractErrorMessage(body); } catch {}
          lastErrorDetail = detail || `server responded with ${res.status}`;
          console.error('Could not send to', r.email, lastErrorDetail);
        }
      } catch (err: any) {
        lastErrorDetail = err?.message || 'network error';
        console.error('Could not send to', r.email, err);
      }
      setSendProgress(sentCount);
    }
    // Only charge credits for emails that actually sent successfully, not the full audience -
    // a merchant shouldn't be billed for sends that failed.
    if (sentCount > 0) {
      try {
        await updateProfile({ messagingCredits: (user?.messagingCredits ?? 0) - (sentCount * CREDITS_PER_EMAIL) });
      } catch (err) {
        console.error('Could not deduct credits:', err);
      }
    }
    setSendResult({ sent: sentCount, total: filteredRecipients.length, errorDetail: sentCount < filteredRecipients.length ? lastErrorDetail : undefined });
    setSending(false);
  };

  if (sendResult) {
    const allFailed = sendResult.sent === 0 && sendResult.total > 0;
    return (
      <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' as const }}>
        {allFailed ? (
          <AlertTriangle size={36} color="#EF4444" style={{ marginBottom: 14 }} />
        ) : (
          <CheckCircle2 size={36} color={C.green} style={{ marginBottom: 14 }} />
        )}
        <p style={{ fontSize: 17, fontWeight: 800, color: C.dark, marginBottom: 6 }}>{allFailed ? 'Sending failed' : 'Campaign sent!'}</p>
        <p style={{ fontSize: 13, color: C.gray, marginBottom: 8 }}>Delivered to {sendResult.sent} of {sendResult.total} customers.</p>
        {sendResult.errorDetail && (
          <p style={{ fontSize: 12, color: '#EF4444', marginBottom: 16, maxWidth: 300, wordBreak: 'break-word' as const }}>{sendResult.errorDetail}</p>
        )}
        <button onClick={onBack} style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 14, padding: '14px 28px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Done</button>
      </div>
    );
  }

  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><ArrowLeft size={18} color="white" /></button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>Email Campaign</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>
        {loading ? (
          <p style={{ textAlign: 'center' as const, color: C.gray, padding: '40px 0' }}>Loading customers...</p>
        ) : sending ? (
          <div style={{ textAlign: 'center' as const, padding: '60px 0' }}>
            <p style={{ fontSize: 15, fontWeight: 700, color: C.dark, marginBottom: 8 }}>Sending...</p>
            <p style={{ fontSize: 13, color: C.gray }}>{sendProgress} of {filteredRecipients.length} sent</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
            <div style={{ background: C.bg, borderRadius: 14, padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <p style={{ fontSize: 11.5, color: C.gray, fontWeight: 700 }}>Messaging Credits</p>
                <p style={{ fontSize: 20, fontWeight: 800, color: C.dark }}>{(user?.messagingCredits ?? 0).toLocaleString()}</p>
              </div>
              <button onClick={() => onNavigate('buy-credits')} style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 10, padding: '10px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                Buy More
              </button>
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Send to</label>
              <select value={audience} onChange={e => setAudience(e.target.value)} style={{ width: '100%', padding: '12px 14px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 14, outline: 'none', background: C.white, color: C.dark }}>
                <option>All Customers</option>
                {allSegments.map(s => <option key={s}>{s}</option>)}
              </select>
              <p style={{ fontSize: 12, color: C.gray, marginTop: 6 }}>{filteredRecipients.length} customer{filteredRecipients.length !== 1 ? 's' : ''} with a saved email will receive this.</p>
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Subject</label>
              <input style={{ width: '100%', padding: '12px 14px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 14, outline: 'none', boxSizing: 'border-box' as const }} placeholder="e.g. New arrivals just dropped!" value={subject} onChange={e => setSubject(e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Message</label>
              <textarea style={{ width: '100%', padding: '12px 14px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 14, outline: 'none', minHeight: 160, resize: 'vertical' as const, fontFamily: 'inherit', boxSizing: 'border-box' as const }} placeholder="Write your message here..." value={message} onChange={e => setMessage(e.target.value)} />
            </div>
            {error && (
              <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>
            )}
            <p style={{ fontSize: 12, color: C.gray, textAlign: 'center' as const }}>This will use {filteredRecipients.length * CREDITS_PER_EMAIL} credits ({CREDITS_PER_EMAIL} per customer)</p>
            <button onClick={handleSend} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>
              Send to {filteredRecipients.length} Customer{filteredRecipients.length !== 1 ? 's' : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ReportsScreen({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [period, setPeriod] = useState<ReportPeriod>('30days');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');
  const [downloaded, setDownloaded] = useState(false);

  useEffect(() => {
    if (!user?.uid) return;
    let productsLoaded = false;
    let expensesLoaded = false;
    const checkDone = () => { if (productsLoaded && expensesLoaded) setLoading(false); };

    const unsubProducts = onSnapshot(
      collection(db, 'merchants', user.uid, 'products'),
      (snap) => {
        const list: Product[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).filter((p: any) => !p._deleted);
        setProducts(list);
        productsLoaded = true;
        checkDone();
      },
      () => { setLoadError('Could not load your data. Check your connection and try again.'); productsLoaded = true; checkDone(); }
    );
    const unsubExpenses = onSnapshot(
      collection(db, 'merchants', user.uid, 'expenses'),
      (snap) => {
        const list: Expense[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).filter((e: any) => !e._deleted);
        setExpenses(list);
        expensesLoaded = true;
        checkDone();
      },
      () => { setLoadError('Could not load your data. Check your connection and try again.'); expensesLoaded = true; checkDone(); }
    );
    return () => { unsubProducts(); unsubExpenses(); };
  }, [user?.uid]);

  const getDateRange = (): { start: Date; label: string } => {
    const now = new Date();
    if (period === '7days') return { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), label: 'Last 7 days' };
    if (period === '30days') return { start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), label: 'Last 30 days' };
    if (period === 'thismonth') return { start: new Date(now.getFullYear(), now.getMonth(), 1), label: 'This month' };
    return { start: new Date(2000, 0, 1), label: 'All time' };
  };

  const { start, label } = getDateRange();
  const filteredExpenses = expenses.filter(e => new Date(e.date) >= start);
  const totalExpenses = filteredExpenses.reduce((sum, e) => sum + e.amount, 0);
  const lowStockCount = products.filter(p => p.status === 'Low stock' || p.status === 'Out of stock').length;
  const activeProductCount = products.length;

  const escapeCsv = (value: string) => {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };

  const handleDownload = () => {
    setGenerateError('');
    setGenerating(true);
    try {
      const rows: string[] = [];
      rows.push(`SalesPilot Report - ${user?.storeName || 'My Store'}`);
      rows.push(`Period: ${label}`);
      rows.push(`Generated: ${new Date().toLocaleString('en-GB')}`);
      rows.push('');
      rows.push('SUMMARY');
      rows.push('Metric,Value');
      rows.push(`Total expenses,${NAIRA}${totalExpenses.toLocaleString()}`);
      rows.push(`Active products,${activeProductCount}`);
      rows.push(`Low or out of stock,${lowStockCount}`);
      rows.push('');
      rows.push('EXPENSES');
      rows.push('Date,Title,Category,Amount,Note');
      filteredExpenses
        .sort((a, b) => b.date.localeCompare(a.date))
        .forEach(e => {
          rows.push([
            e.date,
            escapeCsv(e.title),
            e.category,
            e.amount.toString(),
            escapeCsv(e.note || ''),
          ].join(','));
        });
      rows.push('');
      rows.push('PRODUCTS');
      rows.push('Name,Price,Sale Price,Status,Quantity,Badge');
      products.forEach(p => {
        rows.push([
          escapeCsv(p.name),
          p.price.toString(),
          p.salePrice?.toString() || '',
          p.status,
          typeof p.quantity === 'number' ? p.quantity.toString() : '',
          p.badge,
        ].join(','));
      });

      const csvContent = rows.join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const dateStr = new Date().toISOString().slice(0, 10);
      link.href = url;
      link.download = `salespilot-report-${dateStr}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 2500);
    } catch (err: any) {
      setGenerateError('Could not generate the report. Please try again.');
    } finally {
      setGenerating(false);
    }
  };

  const periods: { id: ReportPeriod; label: string }[] = [
    { id: '7days', label: '7 days' },
    { id: '30days', label: '30 days' },
    { id: 'thismonth', label: 'This month' },
    { id: 'alltime', label: 'All time' },
  ];

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 32px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={18} color="white" />
        </button>
        <h2 style={{ color: 'white', fontSize: 22, fontWeight: 700 }}>Reports</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20 }}>
        {loadError && (
          <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const, marginBottom: 16 }}>{loadError}</div>
        )}
        {loading && !loadError && (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray, fontSize: 14 }}>Loading your data...</div>
        )}
        {!loading && (
          <>
            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: C.dark, marginBottom: 10 }}>Choose a period</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
                {periods.map(p => (
                  <button key={p.id} onClick={() => setPeriod(p.id)} style={{ padding: '10px 16px', borderRadius: 10, border: `1.5px solid ${period === p.id ? C.navy : C.border}`, background: period === p.id ? C.navy : C.white, color: period === p.id ? 'white' : C.gray, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>{p.label}</button>
                ))}
              </div>
            </div>

            <div style={{ border: `1.5px solid ${C.border}`, borderRadius: 14, padding: 16, marginBottom: 20 }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: C.dark, marginBottom: 12 }}>What's included ({label})</p>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${C.border}` }}>
                <span style={{ fontSize: 13, color: C.gray }}>Total expenses</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.dark }}>{NAIRA}{totalExpenses.toLocaleString()}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${C.border}` }}>
                <span style={{ fontSize: 13, color: C.gray }}>Expense records</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.dark }}>{filteredExpenses.length}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}>
                <span style={{ fontSize: 13, color: C.gray }}>Products in catalog</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.dark }}>{activeProductCount}</span>
              </div>
            </div>

            {generateError && (
              <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const, marginBottom: 16 }}>{generateError}</div>
            )}
            {downloaded && (
              <div style={{ background: C.greenLight, color: C.green, borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                <CheckCircle2 size={16} /> Report downloaded
              </div>
            )}

            <button disabled={generating} onClick={handleDownload} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', width: '100%', opacity: generating ? 0.7 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              {generating ? 'Preparing...' : <>Download report (CSV)</>}
            </button>
            <p style={{ fontSize: 11, color: C.gray, marginTop: 10, textAlign: 'center' as const }}>
              Opens in Excel, Google Sheets, or any spreadsheet app
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// Writes a real notification for the merchant to see via the bell icon. Silently logs failure
// rather than throwing, so a notification hiccup never blocks whatever real action triggered it.
async function pushNotification(uid: string, message: string, type: string) {
  try {
    await addDoc(collection(db, 'merchants', uid, 'notifications'), {
      message,
      type,
      read: false,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Could not create notification:', err);
  }
}

// Automatically reduces a product's tracked quantity after a sale (POS or invoice),
// and flips its status label (In stock / Low stock / Out of stock) to match the new count.
// Silently does nothing if the product has no quantity being tracked, or was deleted since.
// Also fires a real notification the moment a product newly crosses into Low/Out of stock,
// so the merchant finds out via the bell icon instead of having to notice it themselves.
async function decrementProductStock(uid: string, productId: string, soldQty: number) {
  try {
    const productRef = doc(db, 'merchants', uid, 'products', productId);
    const snap = await getDoc(productRef);
    if (!snap.exists()) return;
    const data = snap.data() as any;
    if (typeof data.quantity !== 'number') return;
    const newQuantity = Math.max(0, data.quantity - soldQty);
    const newStatus: Product['status'] = newQuantity === 0 ? 'Out of stock' : newQuantity <= 5 ? 'Low stock' : 'In stock';
    await setDoc(productRef, { quantity: newQuantity, status: newStatus }, { merge: true });
    if (newStatus !== data.status && (newStatus === 'Low stock' || newStatus === 'Out of stock')) {
      pushNotification(uid, `${data.name || 'A product'} is now ${newStatus.toLowerCase()}`, newStatus === 'Out of stock' ? 'stock-out' : 'stock-low');
    }
  } catch (err) {
    console.error('Could not auto-update stock for product', productId, err);
  }
}

function InvoiceScreen({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'list' | 'create' | 'detail'>('list');
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [copiedInvoice, setCopiedInvoice] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [items, setItems] = useState<InvoiceItem[]>([{ description: '', quantity: 1, unitPrice: 0 }]);
  const [note, setNote] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    if (!user?.uid) return;
    const unsub = onSnapshot(collection(db, 'merchants', user.uid, 'products'), (snap) => {
      const list: Product[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).filter((p: any) => !p._deleted);
      setProducts(list);
    });
    return unsub;
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid) return;
    const unsub = onSnapshot(collection(db, 'merchants', user.uid, 'invoices'), (snap) => {
      const list: Invoice[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))
        .filter((i: any) => !i._deleted)
        .sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt));
      setInvoices(list);
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, [user?.uid]);

  const resetForm = () => {
    setCustomerName(''); setCustomerPhone(''); setCustomerEmail('');
    setItems([{ description: '', quantity: 1, unitPrice: 0 }]);
    setNote(''); setDueDate(''); setError('');
  };

  const total = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);

  const handleCreate = async () => {
    setError('');
    if (!customerName.trim()) { setError('Please enter the customer name.'); return; }
    if (items.some(i => !i.description.trim() || i.quantity < 1 || i.unitPrice <= 0)) {
      setError('Please fill in all item details correctly.'); return;
    }
    setSaving(true);
    try {
      const invNum = `INV-${Date.now().toString().slice(-6)}`;
      const inv: Invoice = {
        id: Date.now().toString(), invoiceNumber: invNum,
        customerName: customerName.trim(), customerPhone: customerPhone.trim() || undefined,
        customerEmail: customerEmail.trim() || undefined, items,
        note: note.trim() || undefined, date: new Date().toISOString().slice(0, 10),
        dueDate: dueDate || undefined, paid: false, createdAt: new Date().toISOString(),
      };
      await setDoc(doc(db, 'merchants', user!.uid, 'invoices', inv.id), inv);
      resetForm();
      setView('list');
    } catch (err: any) {
      console.error('Invoice creation failed:', err);
      setError('Could not create invoice. Please check your connection and try again.');
    } finally { setSaving(false); }
  };

  const markPaid = async (inv: Invoice) => {
    if (!user?.uid) return;
    await setDoc(doc(db, 'merchants', user.uid, 'invoices', inv.id), { paid: true }, { merge: true });
    await Promise.all(inv.items.filter(i => i.productId).map(i => decrementProductStock(user.uid, i.productId!, i.quantity)));
  };

  const deleteInvoice = async (id: string) => {
    if (!user?.uid) return;
    await setDoc(doc(db, 'merchants', user.uid, 'invoices', id), { _deleted: true }, { merge: true });
    setView('list'); setSelected(null);
  };

  const inp = { width: '100%', padding: '12px 14px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 14, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };
  const lbl = { fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 6 };

  if (view === 'create') return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif', paddingBottom: 100 }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={() => { resetForm(); setView('list'); }} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><ArrowLeft size={18} color="white" /></button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>New Invoice</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
          <div><label style={lbl}>Customer name</label><input style={inp} placeholder="e.g. Amaka Johnson" value={customerName} onChange={e => setCustomerName(e.target.value)} /></div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}><label style={lbl}>Phone</label><input style={inp} placeholder="08012345678" value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} /></div>
            <div style={{ flex: 1 }}><label style={lbl}>Due date</label><input style={inp} type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /></div>
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={lbl}>Items</label>
              <button onClick={() => setItems([...items, { description: '', quantity: 1, unitPrice: 0 }])} style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 8, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}><Plus size={12} /> Add item</button>
            </div>
            {items.map((item, i) => (
              <div key={i} style={{ background: C.bg, borderRadius: 12, padding: 12, marginBottom: 8 }}>
                <select
                  style={{ ...inp, marginBottom: 8, appearance: 'none' } as any}
                  value={item.productId || '__custom__'}
                  onChange={e => {
                    const val = e.target.value;
                    if (val === '__custom__') {
                      setItems(items.map((it, j) => j === i ? { description: '', quantity: it.quantity, unitPrice: 0 } : it));
                    } else {
                      const p = products.find(pr => pr.id === val);
                      if (p) setItems(items.map((it, j) => j === i ? { description: p.name, quantity: it.quantity, unitPrice: p.salePrice || p.price, productId: p.id } : it));
                    }
                  }}
                >
                  <option value="__custom__">Custom item (not in inventory)</option>
                  {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.quantity ?? '?'} in stock)</option>)}
                </select>
                {!item.productId && (
                  <input style={{ ...inp, marginBottom: 8 }} placeholder="Item description" value={item.description} onChange={e => setItems(items.map((it, j) => j === i ? { ...it, description: e.target.value } : it))} />
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}><input style={inp} type="number" placeholder="Qty" value={item.quantity || ''} onChange={e => setItems(items.map((it, j) => j === i ? { ...it, quantity: Number(e.target.value) } : it))} /></div>
                  <div style={{ flex: 2 }}><input style={inp} type="number" placeholder="Unit price" value={item.unitPrice || ''} disabled={!!item.productId} onChange={e => setItems(items.map((it, j) => j === i ? { ...it, unitPrice: Number(e.target.value) } : it))} /></div>
                  {items.length > 1 && <button onClick={() => setItems(items.filter((_, j) => j !== i))} style={{ background: '#FEE2E2', border: 'none', borderRadius: 8, width: 36, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}><Trash2 size={14} color="#EF4444" /></button>}
                </div>
                <p style={{ fontSize: 12, color: C.gray, marginTop: 6, textAlign: 'right' as const }}>Subtotal: {NAIRA}{(item.quantity * item.unitPrice).toLocaleString()}</p>
                {item.productId && <p style={{ fontSize: 11, color: C.gray, marginTop: 4 }}>Stock updates automatically once this invoice is marked paid.</p>}
              </div>
            ))}
          </div>
          <div style={{ background: C.navy, borderRadius: 12, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14 }}>Total</span>
            <span style={{ color: 'white', fontSize: 20, fontWeight: 800 }}>{NAIRA}{total.toLocaleString()}</span>
          </div>
          <div><label style={lbl}>Note <span style={{ color: C.gray, fontWeight: 400 }}>(optional)</span></label><textarea style={{ ...inp, minHeight: 60, resize: 'vertical' as const, fontFamily: 'inherit' }} placeholder="Payment instructions or thank you message..." value={note} onChange={e => setNote(e.target.value)} maxLength={200} /></div>
          {error && <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>}
          <button disabled={saving} onClick={handleCreate} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>{saving ? 'Creating...' : 'Create invoice'}</button>
        </div>
      </div>
    </div>
  );

  if (view === 'detail' && selected) return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif', paddingBottom: 100 }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={() => { setView('list'); setSelected(null); }} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><ArrowLeft size={18} color="white" /></button>
        <div style={{ flex: 1 }}>
          <h2 style={{ color: 'white', fontSize: 18, fontWeight: 700 }}>{selected.invoiceNumber}</h2>
          <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>{selected.customerName}</p>
        </div>
        <span style={{ background: selected.paid ? C.greenLight : C.orangeLight, color: selected.paid ? C.green : C.orange, fontSize: 11, fontWeight: 700, padding: '4px 12px', borderRadius: 20 }}>{selected.paid ? 'Paid' : 'Unpaid'}</span>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 16, marginBottom: 16, borderBottom: `1px solid ${C.border}` }}>
          {user?.logoUrl ? (
            <img src={user.logoUrl} alt={user?.storeName} style={{ width: 44, height: 44, borderRadius: 10, objectFit: 'cover' as const, flexShrink: 0 }} />
          ) : (
            <div style={{ width: 44, height: 44, borderRadius: 10, background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Store size={20} color="white" />
            </div>
          )}
          <div>
            <p style={{ fontSize: 16, fontWeight: 800, color: C.dark }}>{user?.storeName || 'Your Store'}</p>
            <p style={{ fontSize: 11.5, color: C.gray }}>Invoice / Receipt</p>
          </div>
        </div>
        <div style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 12, color: C.gray }}>Invoice date: {selected.date}</p>
          {selected.dueDate && <p style={{ fontSize: 12, color: C.gray }}>Due: {selected.dueDate}</p>}
          {selected.customerPhone && <p style={{ fontSize: 12, color: C.gray }}>Phone: {selected.customerPhone}</p>}
        </div>
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
          <div style={{ background: C.bg, padding: '10px 14px', display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.gray }}>ITEM</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.gray }}>AMOUNT</span>
          </div>
          {selected.items.map((item, i) => (
            <div key={i} style={{ padding: '12px 14px', borderTop: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div><p style={{ fontSize: 14, fontWeight: 600, color: C.dark }}>{item.description}</p><p style={{ fontSize: 12, color: C.gray }}>{item.quantity} x {NAIRA}{item.unitPrice.toLocaleString()}</p></div>
              <p style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>{NAIRA}{(item.quantity * item.unitPrice).toLocaleString()}</p>
            </div>
          ))}
          <div style={{ padding: '12px 14px', borderTop: `2px solid ${C.border}`, display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: C.dark }}>Total</span>
            <span style={{ fontSize: 15, fontWeight: 800, color: C.navy }}>{NAIRA}{selected.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0).toLocaleString()}</span>
          </div>
        </div>
        {selected.note && <div style={{ background: C.bg, borderRadius: 12, padding: '12px 14px', marginBottom: 16 }}><p style={{ fontSize: 13, color: C.gray }}>{selected.note}</p></div>}
        {(() => {
          const invoiceText = `*${user?.storeName || 'Invoice'}*\n\n${selected.invoiceNumber}\n${selected.paid ? 'PAID' : 'UNPAID'}\n\n` +
            selected.items.map(i => `${i.description} x${i.quantity} - ${NAIRA}${(i.quantity * i.unitPrice).toLocaleString()}`).join('\n') +
            `\n\n*Total: ${NAIRA}${selected.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0).toLocaleString()}*` +
            (selected.note ? `\n\n${selected.note}` : '');
          return selected.customerPhone ? (
            <a
              href={`https://wa.me/${selected.customerPhone.replace(/\D/g, '')}?text=${encodeURIComponent(invoiceText)}`}
              target="_blank"
              rel="noreferrer"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: '#25D366', color: 'white', border: 'none', borderRadius: 12, padding: 14, fontSize: 14, fontWeight: 700, textDecoration: 'none', marginBottom: 10 }}
            >
              <Share2 size={16} /> Send to Customer on WhatsApp
            </a>
          ) : (
            <button
              onClick={() => { copyToClipboard(invoiceText); setCopiedInvoice(true); setTimeout(() => setCopiedInvoice(false), 2000); }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: C.bg, color: C.dark, border: `1px solid ${C.border}`, borderRadius: 12, padding: 14, fontSize: 14, fontWeight: 700, cursor: 'pointer', marginBottom: 10 }}
            >
              <Copy size={16} /> {copiedInvoice ? 'Copied!' : 'Copy Invoice Text (no phone number saved)'}
            </button>
          );
        })()}
        <div style={{ display: 'flex', gap: 10 }}>
          {!selected.paid && <button onClick={() => { markPaid(selected); setSelected({ ...selected, paid: true }); }} style={{ flex: 1, background: C.green, color: 'white', border: 'none', borderRadius: 12, padding: 14, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>Mark as paid</button>}
          <button onClick={() => deleteInvoice(selected.id)} style={{ flex: 1, background: '#FEE2E2', color: '#EF4444', border: 'none', borderRadius: 12, padding: 14, fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><Trash2 size={14} /> Delete</button>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 32px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><ArrowLeft size={18} color="white" /></button>
        <h2 style={{ color: 'white', fontSize: 22, fontWeight: 700, flex: 1 }}>Invoices</h2>
        <button onClick={() => setView('create')} style={{ background: C.green, border: 'none', borderRadius: 12, width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><Plus size={20} color="white" /></button>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20 }}>
        {loading && <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray }}>Loading invoices...</div>}
        {!loading && invoices.length === 0 && (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray }}>
            <FileText size={32} color={C.border} style={{ marginBottom: 12 }} />
            <p>No invoices yet. Tap + to create one.</p>
          </div>
        )}
        {invoices.map(inv => {
          const invTotal = inv.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
          return (
            <div key={inv.id} onClick={() => { setSelected(inv); setView('detail'); }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                  <p style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>{inv.invoiceNumber}</p>
                  <span style={{ background: inv.paid ? C.greenLight : C.orangeLight, color: inv.paid ? C.green : C.orange, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>{inv.paid ? 'Paid' : 'Unpaid'}</span>
                </div>
                <p style={{ fontSize: 13, color: C.gray }}>{inv.customerName} - {inv.date}</p>
              </div>
              <div style={{ textAlign: 'right' as const }}>
                <p style={{ fontSize: 15, fontWeight: 700, color: C.navy }}>{NAIRA}{invTotal.toLocaleString()}</p>
                <ChevronRight size={16} color={C.gray} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function POSScreen({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [sales, setSales] = useState<POSSale[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [salesFilter, setSalesFilter] = useState('Today');

  const [customerName, setCustomerName] = useState('');
  const [items, setItems] = useState<{ description: string; quantity: number; unitPrice: number; productId?: string }[]>([{ description: '', quantity: 1, unitPrice: 0 }]);
  const [paymentMethod, setPaymentMethod] = useState<POSSale['paymentMethod']>('Cash');
  const [products, setProducts] = useState<Product[]>([]);
  const [showPosScanner, setShowPosScanner] = useState(false);
  const [barcodeError, setBarcodeError] = useState('');

  useEffect(() => {
    if (!user?.uid) return;
    const unsub = onSnapshot(collection(db, 'merchants', user.uid, 'products'), (snap) => {
      const list: Product[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).filter((p: any) => !p._deleted);
      setProducts(list);
    });
    return unsub;
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid) return;
    const unsub = onSnapshot(collection(db, 'merchants', user.uid, 'pos_sales'), (snap) => {
      const list: POSSale[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))
        .filter((s: any) => !s._deleted)
        .sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt));
      setSales(list);
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, [user?.uid]);

  const total = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);

  const handleSave = async () => {
    setError('');
    if (items.some(i => !i.description.trim() || i.quantity < 1 || i.unitPrice <= 0)) {
      setError('Please fill in all item details.'); return;
    }
    setSaving(true);
    try {
      const sale: POSSale = {
        id: Date.now().toString(), customerName: customerName.trim() || undefined,
        items, total, paymentMethod, date: new Date().toISOString().slice(0, 10),
        createdAt: new Date().toISOString(),
      };
      await setDoc(doc(db, 'merchants', user!.uid, 'pos_sales', sale.id), sale);
      await Promise.all(items.filter(i => i.productId).map(i => decrementProductStock(user!.uid, i.productId!, i.quantity)));
      setCustomerName(''); setItems([{ description: '', quantity: 1, unitPrice: 0 }]); setPaymentMethod('Cash');
      setShowForm(false); setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      console.error('POS sale save failed:', err);
      setError('Could not record sale. Please check your connection and try again.');
    } finally { setSaving(false); }
  };

  const inp = { width: '100%', padding: '12px 14px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 14, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };
  const lbl = { fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 6 };
  const methods: POSSale['paymentMethod'][] = ['Cash', 'Transfer', 'POS', 'Other'];

  const periodTotal = sales.filter(s => {
    const d = s.date;
    const now = new Date();
    if (salesFilter === 'Today') return d === now.toISOString().slice(0, 10);
    if (salesFilter === 'This Week') return d >= new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return d?.slice(0, 7) === now.toISOString().slice(0, 7);
  }).reduce((sum, s) => sum + s.total, 0);

  if (showForm) return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'Inter, sans-serif', paddingBottom: 100 }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={() => setShowForm(false)} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><ArrowLeft size={18} color="white" /></button>
        <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>Record a sale</h2>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
          <div><label style={lbl}>Customer name <span style={{ color: C.gray, fontWeight: 400 }}>(optional)</span></label><input style={inp} placeholder="Walk-in customer" value={customerName} onChange={e => setCustomerName(e.target.value)} /></div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={lbl}>Items sold</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => setShowPosScanner(true)} style={{ background: C.bg, color: C.navy, border: `1.5px solid ${C.navy}`, borderRadius: 8, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}><Camera size={12} /> Scan</button>
                <button onClick={() => setItems([...items, { description: '', quantity: 1, unitPrice: 0 }])} style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 8, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}><Plus size={12} /> Add</button>
              </div>
            </div>
            {barcodeError && <p style={{ color: '#EF4444', fontSize: 12, marginBottom: 8 }}>{barcodeError}</p>}
            {showPosScanner && (
              <BarcodeScannerModal
                onDetected={(code) => {
                  setShowPosScanner(false);
                  const match = products.find(p => p.barcode && p.barcode === code);
                  if (!match) { setBarcodeError(`No product found with barcode ${code}.`); return; }
                  setBarcodeError('');
                  const existingIndex = items.findIndex(i => i.productId === match.id);
                  if (existingIndex >= 0) {
                    setItems(items.map((it, i) => i === existingIndex ? { ...it, quantity: it.quantity + 1 } : it));
                  } else {
                    const blankIndex = items.findIndex(i => !i.description.trim());
                    const newItem = { description: match.name, quantity: 1, unitPrice: match.salePrice || match.price, productId: match.id };
                    if (blankIndex >= 0) {
                      setItems(items.map((it, i) => i === blankIndex ? newItem : it));
                    } else {
                      setItems([...items, newItem]);
                    }
                  }
                }}
                onClose={() => setShowPosScanner(false)}
              />
            )}
            {items.map((item, i) => (
              <div key={i} style={{ background: C.bg, borderRadius: 12, padding: 12, marginBottom: 8 }}>
                <select
                  style={{ ...inp, marginBottom: 8, appearance: 'none' } as any}
                  value={item.productId || '__custom__'}
                  onChange={e => {
                    const val = e.target.value;
                    if (val === '__custom__') {
                      setItems(items.map((it, j) => j === i ? { description: '', quantity: it.quantity, unitPrice: 0 } : it));
                    } else {
                      const p = products.find(pr => pr.id === val);
                      if (p) setItems(items.map((it, j) => j === i ? { description: p.name, quantity: it.quantity, unitPrice: p.salePrice || p.price, productId: p.id } : it));
                    }
                  }}
                >
                  <option value="__custom__">Custom item (not in inventory)</option>
                  {products.map(p => <option key={p.id} value={p.id}>{p.name} ({p.quantity ?? '?'} in stock)</option>)}
                </select>
                {!item.productId && (
                  <input style={{ ...inp, marginBottom: 8 }} placeholder="What was sold" value={item.description} onChange={e => setItems(items.map((it, j) => j === i ? { ...it, description: e.target.value } : it))} />
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}><input style={inp} type="number" placeholder="Qty" value={item.quantity || ''} onChange={e => setItems(items.map((it, j) => j === i ? { ...it, quantity: Number(e.target.value) } : it))} /></div>
                  <div style={{ flex: 2 }}><input style={inp} type="number" placeholder="Price" value={item.unitPrice || ''} disabled={!!item.productId} onChange={e => setItems(items.map((it, j) => j === i ? { ...it, unitPrice: Number(e.target.value) } : it))} /></div>
                  {items.length > 1 && <button onClick={() => setItems(items.filter((_, j) => j !== i))} style={{ background: '#FEE2E2', border: 'none', borderRadius: 8, width: 36, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}><Trash2 size={14} color="#EF4444" /></button>}
                </div>
                {item.productId && <p style={{ fontSize: 11, color: C.gray, marginTop: 6 }}>Stock will update automatically after this sale.</p>}
              </div>
            ))}
          </div>
          <div>
            <label style={lbl}>Payment method</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
              {methods.map(m => <button key={m} onClick={() => setPaymentMethod(m)} style={{ padding: '10px 16px', borderRadius: 10, border: `1.5px solid ${paymentMethod === m ? C.navy : C.border}`, background: paymentMethod === m ? C.navy : C.white, color: paymentMethod === m ? 'white' : C.gray, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>{m}</button>)}
            </div>
          </div>
          <div style={{ background: C.navy, borderRadius: 12, padding: '12px 16px', display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14 }}>Total received</span>
            <span style={{ color: 'white', fontSize: 20, fontWeight: 800 }}>{NAIRA}{total.toLocaleString()}</span>
          </div>
          {error && <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>}
          <button disabled={saving} onClick={handleSave} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>{saving ? 'Saving...' : 'Record sale'}</button>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 32px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><ArrowLeft size={18} color="white" /></button>
        <h2 style={{ color: 'white', fontSize: 22, fontWeight: 700, flex: 1 }}>Point of Sale</h2>
        <button onClick={() => setShowForm(true)} style={{ background: C.green, border: 'none', borderRadius: 12, width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><Plus size={20} color="white" /></button>
      </div>
      <div style={{ padding: '0 16px', marginTop: -16 }}>
        <div style={{ background: `linear-gradient(135deg, ${C.navy} 0%, #0E2038 100%)`, borderRadius: 20, padding: '16px 18px', marginBottom: 16, boxShadow: '0 8px 32px rgba(20,42,69,0.35)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
            <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>Offline sales</p>
            <select value={salesFilter} onChange={e => setSalesFilter(e.target.value)} style={{ background: 'rgba(255,255,255,0.12)', border: 'none', borderRadius: 8, padding: '4px 8px', color: 'white', fontSize: 11.5, cursor: 'pointer', outline: 'none' }}>
              <option style={{ color: C.dark }}>Today</option>
              <option style={{ color: C.dark }}>This Week</option>
              <option style={{ color: C.dark }}>This Month</option>
            </select>
          </div>
          <h1 style={{ color: 'white', fontSize: 30, fontWeight: 800 }}>{NAIRA}{periodTotal.toLocaleString()}</h1>
        </div>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', padding: 20 }}>
        {saved && <div style={{ background: C.greenLight, color: C.green, borderRadius: 12, padding: '10px 14px', fontSize: 13, fontWeight: 600, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 6 }}><CheckCircle2 size={14} /> Sale recorded</div>}
        {loading && <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray }}>Loading sales...</div>}
        {!loading && sales.length === 0 && <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray }}><ShoppingBag size={32} color={C.border} style={{ marginBottom: 12 }} /><p>No offline sales yet. Tap + to record one.</p></div>}
        {sales.map(sale => (
          <div key={sale.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: `1px solid ${C.border}` }}>
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, color: C.dark, marginBottom: 2 }}>{sale.customerName || 'Walk-in customer'}</p>
              <p style={{ fontSize: 12, color: C.gray }}>{sale.paymentMethod} - {sale.date} - {sale.items.length} item{sale.items.length > 1 ? 's' : ''}</p>
            </div>
            <p style={{ fontSize: 15, fontWeight: 700, color: C.green }}>{NAIRA}{sale.total.toLocaleString()}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
function StaffScreen({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<StaffRole>('Sales');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.uid) return;
    const unsub = onSnapshot(collection(db, 'merchants', user.uid, 'staff'), (snap) => {
      const list: StaffMember[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))
        .filter((s: any) => !s._deleted)
        .sort((a: any, b: any) => b.invitedAt.localeCompare(a.invitedAt));
      setStaff(list);
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, [user?.uid]);

  const handleInvite = async () => {
    setError('');
    if (!email.trim() || !email.includes('@')) { setError('Please enter a valid email address.'); return; }
    if (!name.trim()) { setError('Please enter the staff member\'s name.'); return; }
    if (staff.find(s => s.email === email.trim().toLowerCase())) { setError('This email is already added as a staff member.'); return; }
    setSaving(true);
    try {
      const inviteCode = Math.random().toString(36).slice(2, 8).toUpperCase();
      const member: StaffMember = {
        id: Date.now().toString(), email: email.trim().toLowerCase(), name: name.trim(),
        role, invitedAt: new Date().toISOString(), status: 'pending', inviteCode,
      };
      await setDoc(doc(db, 'merchants', user!.uid, 'staff', member.id), member);
      setEmail(''); setName(''); setRole('Sales'); setShowForm(false);
    } catch (err: any) {
      setError(err?.message || 'Could not add staff member.');
    } finally { setSaving(false); }
  };

  const removeStaff = async (id: string) => {
    if (!user?.uid) return;
    await setDoc(doc(db, 'merchants', user.uid, 'staff', id), { _deleted: true }, { merge: true });
  };

  const inp = { width: '100%', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 15, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };
  const lbl = { fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 };
  const roles: StaffRole[] = ['Admin', 'Sales', 'Inventory'];
  const roleDesc = { Admin: 'Full access to everything', Sales: 'Can view orders and record sales', Inventory: 'Can manage products and stock' };
  const roleColors = { Admin: { bg: C.blueLight, color: C.blue }, Sales: { bg: C.greenLight, color: C.green }, Inventory: { bg: C.purpleLight, color: C.purple } };

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 32px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><ArrowLeft size={18} color="white" /></button>
        <h2 style={{ color: 'white', fontSize: 22, fontWeight: 700, flex: 1 }}>Staff Accounts</h2>
        <button onClick={() => setShowForm(!showForm)} style={{ background: C.green, border: 'none', borderRadius: 12, width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><Plus size={20} color="white" /></button>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20 }}>
        {showForm && (
          <div style={{ background: C.bg, borderRadius: 16, padding: 16, marginBottom: 20 }}>
            <p style={{ fontSize: 15, fontWeight: 700, color: C.dark, marginBottom: 14 }}>Invite a staff member</p>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
              <div><label style={lbl}>Full name</label><input style={inp} placeholder="e.g. Tunde Adeyemi" value={name} onChange={e => setName(e.target.value)} /></div>
              <div><label style={lbl}>Email address</label><input style={inp} type="email" placeholder="tunde@gmail.com" value={email} onChange={e => setEmail(e.target.value)} /></div>
              <div>
                <label style={lbl}>Role</label>
                {roles.map(r => (
                  <div key={r} onClick={() => setRole(r)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 12, border: `1.5px solid ${role === r ? C.navy : C.border}`, background: role === r ? `${C.navy}08` : C.white, cursor: 'pointer', marginBottom: 8 }}>
                    <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${role === r ? C.navy : C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {role === r && <div style={{ width: 10, height: 10, borderRadius: '50%', background: C.navy }} />}
                    </div>
                    <div>
                      <p style={{ fontSize: 14, fontWeight: 600, color: C.dark }}>{r}</p>
                      <p style={{ fontSize: 12, color: C.gray }}>{roleDesc[r]}</p>
                    </div>
                  </div>
                ))}
              </div>
              {error && <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>}
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => { setShowForm(false); setError(''); }} style={{ flex: 1, background: C.bg, border: 'none', borderRadius: 12, padding: 14, fontSize: 14, fontWeight: 600, color: C.gray, cursor: 'pointer' }}>Cancel</button>
                <button disabled={saving} onClick={handleInvite} style={{ flex: 2, background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 12, padding: 14, fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>{saving ? 'Adding...' : 'Add staff member'}</button>
              </div>
            </div>
          </div>
        )}

        <div style={{ background: C.bg, borderRadius: 12, padding: '12px 14px', marginBottom: 16 }}>
          <p style={{ fontSize: 12, color: C.gray, lineHeight: 1.5 }}>Staff members log in with their own email and password. They will see a limited dashboard based on their role. You can remove them at any time.</p>
        </div>

        {loading && <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray }}>Loading staff...</div>}
        {!loading && staff.length === 0 && !showForm && (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray }}>
            <Users size={32} color={C.border} style={{ marginBottom: 12 }} />
            <p>No staff members yet. Tap + to invite someone.</p>
          </div>
        )}
        {staff.map(member => (
          <div key={member.id} style={{ padding: '14px 0', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 46, height: 46, borderRadius: '50%', background: roleColors[member.role].bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, color: roleColors[member.role].color, flexShrink: 0 }}>
                {member.name[0]}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <p style={{ fontSize: 15, fontWeight: 600, color: C.dark }}>{member.name}</p>
                  <span style={{ background: roleColors[member.role].bg, color: roleColors[member.role].color, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>{member.role}</span>
                </div>
                <p style={{ fontSize: 12, color: C.gray }}>{member.email}</p>
                <p style={{ fontSize: 11, color: member.status === 'pending' ? C.orange : C.green, fontWeight: 600 }}>{member.status === 'pending' ? 'Pending - not yet signed in' : 'Active'}</p>
              </div>
              <button onClick={() => removeStaff(member.id)} style={{ background: '#FEE2E2', border: 'none', borderRadius: 8, width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}><Trash2 size={14} color="#EF4444" /></button>
            </div>
            {member.status === 'pending' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(`Hi ${member.name}, you've been invited to join ${user?.storeName || 'our store'} on SalesPilot. Tap this link to set your password and get started: ${window.location.origin}/join-staff/${user!.uid}/${member.id}/${member.inviteCode}`)}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: '#25D366', color: 'white', border: 'none', borderRadius: 10, padding: 11, fontSize: 12.5, fontWeight: 700, textDecoration: 'none' }}
                >
                  <Share2 size={13} /> WhatsApp
                </a>
                <button
                  onClick={() => {
                    const link = `${window.location.origin}/join-staff/${user!.uid}/${member.id}/${member.inviteCode}`;
                    copyToClipboard(link);
                    setCopiedId(member.id);
                    setTimeout(() => setCopiedId(null), 2000);
                  }}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: C.bg, color: C.dark, border: `1px solid ${C.border}`, borderRadius: 10, padding: 11, fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}
                >
                  <Copy size={13} /> {copiedId === member.id ? 'Copied!' : 'Copy Link'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

type AggregatedCustomer = {
  key: string;
  name: string;
  phone?: string;
  email?: string;
  notes?: string;
  totalSpent: number;
  orderCount: number;
  lastDate: string;
  isManualOnly: boolean;
  manualId?: string;
  history: { source: 'Invoice' | 'POS' | 'Order'; label: string; amount: number; date: string }[];
  segments?: string[];
};

function normalizeName(n: string) {
  return n.trim().toLowerCase();
}

function CustomerFormModal({ onSave, onCancel }: { onSave: (c: { name: string; phone?: string; email?: string; notes?: string }) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const inp = { width: '100%', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 15, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };
  const lbl = { fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 };

  const handleSave = async () => {
    setError('');
    if (!name.trim()) {
      setError('Please enter the customer name.');
      return;
    }
    setSaving(true);
    try {
      await onSave({ name: name.trim(), phone: phone.trim() || undefined, email: email.trim() || undefined, notes: notes.trim() || undefined });
    } catch (err: any) {
      setError(err?.message || 'Could not save customer.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 300, display: 'flex', alignItems: 'flex-end' }}>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', padding: 20, width: '100%', maxHeight: '85vh', overflowY: 'auto' as const }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 18, fontWeight: 700, color: C.dark }}>Add customer</h3>
          <button onClick={onCancel} style={{ background: C.bg, border: 'none', borderRadius: 8, width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><X size={16} color={C.gray} /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
          <div><label style={lbl}>Full name</label><input style={inp} placeholder="e.g. Amaka Johnson" value={name} onChange={e => setName(e.target.value)} /></div>
          <div><label style={lbl}>Phone <span style={{ color: C.gray, fontWeight: 400 }}>(optional)</span></label><input style={inp} placeholder="08012345678" value={phone} onChange={e => setPhone(e.target.value)} /></div>
          <div><label style={lbl}>Email <span style={{ color: C.gray, fontWeight: 400 }}>(optional)</span></label><input style={inp} type="email" placeholder="amaka@gmail.com" value={email} onChange={e => setEmail(e.target.value)} /></div>
          <div><label style={lbl}>Notes <span style={{ color: C.gray, fontWeight: 400 }}>(optional)</span></label><textarea style={{ ...inp, minHeight: 70, resize: 'vertical' as const, fontFamily: 'inherit' }} placeholder="Preferences, sizes, anything worth remembering..." value={notes} onChange={e => setNotes(e.target.value)} maxLength={300} /></div>
          {error && <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>}
          <button disabled={saving} onClick={handleSave} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>{saving ? 'Saving...' : 'Add customer'}</button>
        </div>
      </div>
    </div>
  );
}

function CustomerDetailScreen({ customer, onBack, onDeleteManual, allSegments }: { customer: AggregatedCustomer; onBack: () => void; onDeleteManual?: () => void; allSegments: string[] }) {
  const { user } = useAuth();
  const [segments, setSegments] = useState<string[]>(customer.segments || []);
  const [newSegment, setNewSegment] = useState('');
  const [savingSegment, setSavingSegment] = useState(false);

  const saveSegments = async (updated: string[]) => {
    if (!user?.uid) return;
    setSavingSegment(true);
    try {
      await setDoc(doc(db, 'merchants', user.uid, 'customerSegments', customer.key), { name: customer.name, segments: updated }, { merge: true });
      setSegments(updated);
    } catch (err) {
      console.error('Could not save segment:', err);
    } finally {
      setSavingSegment(false);
    }
  };

  const addSegment = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || segments.includes(trimmed)) return;
    saveSegments([...segments, trimmed]);
    setNewSegment('');
  };

  const removeSegment = (name: string) => {
    saveSegments(segments.filter(s => s !== name));
  };

  const suggestions = allSegments.filter(s => !segments.includes(s) && s.toLowerCase().includes(newSegment.toLowerCase()) && newSegment.length > 0);

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 32px', display: 'flex', alignItems: 'center', gap: 14 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><ArrowLeft size={18} color="white" /></button>
        <div style={{ flex: 1 }}>
          <h2 style={{ color: 'white', fontSize: 19, fontWeight: 700 }}>{customer.name}</h2>
          <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>{customer.orderCount} order{customer.orderCount !== 1 ? 's' : ''} - {NAIRA}{customer.totalSpent.toLocaleString()} spent</p>
        </div>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20 }}>
        {(customer.phone || customer.email || customer.notes) && (
          <div style={{ background: C.bg, borderRadius: 14, padding: 16, marginBottom: 20 }}>
            {customer.phone && <p style={{ fontSize: 13, color: C.dark, marginBottom: 6 }}><span style={{ color: C.gray }}>Phone: </span>{customer.phone}</p>}
            {customer.email && <p style={{ fontSize: 13, color: C.dark, marginBottom: 6 }}><span style={{ color: C.gray }}>Email: </span>{customer.email}</p>}
            {customer.notes && <p style={{ fontSize: 13, color: C.dark }}><span style={{ color: C.gray }}>Notes: </span>{customer.notes}</p>}
          </div>
        )}

        <p style={{ fontSize: 14, fontWeight: 700, color: C.dark, marginBottom: 12 }}>Groups</p>
        <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 8, marginBottom: 12 }}>
          {segments.map(s => (
            <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 6, background: C.purpleLight, color: C.purple, fontSize: 12, fontWeight: 700, padding: '6px 10px', borderRadius: 20 }}>
              {s}
              <button onClick={() => removeSegment(s)} disabled={savingSegment} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 0, color: C.purple }}><X size={12} /></button>
            </span>
          ))}
        </div>
        <div style={{ position: 'relative' as const, marginBottom: 24 }}>
          {isProAccess(user) ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, fontSize: 13, outline: 'none' }}
                placeholder="Add to a group (e.g. VIP, Wholesale)"
                value={newSegment}
                onChange={e => setNewSegment(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addSegment(newSegment); }}
              />
              <button onClick={() => addSegment(newSegment)} disabled={!newSegment.trim() || savingSegment} style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 10, padding: '0 16px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', opacity: !newSegment.trim() ? 0.5 : 1 }}>Add</button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.bg, borderRadius: 10, padding: '10px 12px' }}>
              <span style={{ background: C.navy, color: 'white', fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 20 }}>PRO</span>
              <p style={{ fontSize: 12.5, color: C.gray, flex: 1 }}>Upgrade to Pro to sort customers into groups like VIP or Wholesale.</p>
            </div>
          )}
          {suggestions.length > 0 && (
            <div style={{ background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, marginTop: 4, overflow: 'hidden' }}>
              {suggestions.slice(0, 4).map(s => (
                <button key={s} onClick={() => addSegment(s)} style={{ display: 'block', width: '100%', textAlign: 'left' as const, background: 'none', border: 'none', padding: '9px 12px', fontSize: 13, color: C.dark, cursor: 'pointer' }}>{s}</button>
              ))}
            </div>
          )}
        </div>

        <p style={{ fontSize: 14, fontWeight: 700, color: C.dark, marginBottom: 12 }}>Order history</p>
        {customer.history.length === 0 && (
          <p style={{ fontSize: 13, color: C.gray, textAlign: 'center' as const, padding: '20px 0' }}>No orders recorded yet.</p>
        )}
        {customer.history.map((h, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: `1px solid ${C.border}` }}>
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, color: C.dark, marginBottom: 2 }}>{h.label}</p>
              <p style={{ fontSize: 12, color: C.gray }}>{h.source} - {h.date}</p>
            </div>
            <p style={{ fontSize: 14, fontWeight: 700, color: C.navy }}>{NAIRA}{h.amount.toLocaleString()}</p>
          </div>
        ))}
        {customer.isManualOnly && onDeleteManual && (
          <button onClick={onDeleteManual} style={{ width: '100%', background: '#FEE2E2', color: '#EF4444', border: 'none', borderRadius: 14, padding: 14, fontSize: 15, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 24 }}>
            <Trash2 size={16} /> Remove customer
          </button>
        )}
      </div>
    </div>
  );
}

function CustomersScreen() {
  const { user } = useAuth();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [posSales, setPosSales] = useState<POSSale[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [manualCustomers, setManualCustomers] = useState<CustomerRecord[]>([]);
  const [segmentsMap, setSegmentsMap] = useState<{ [key: string]: string[] }>({});
  const [activeSegmentFilter, setActiveSegmentFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [selected, setSelected] = useState<AggregatedCustomer | null>(null);
  const [addError, setAddError] = useState('');

  useEffect(() => {
    if (!user?.uid) return;
    const unsub = onSnapshot(collection(db, 'merchants', user.uid, 'customerSegments'), (snap) => {
      const map: { [key: string]: string[] } = {};
      snap.docs.forEach(d => { map[d.id] = (d.data() as any).segments || []; });
      setSegmentsMap(map);
    });
    return unsub;
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid) return;
    let invLoaded = false, posLoaded = false, custLoaded = false, ordLoaded = false;
    const checkDone = () => { if (invLoaded && posLoaded && custLoaded && ordLoaded) setLoading(false); };

    const unsubInv = onSnapshot(collection(db, 'merchants', user.uid, 'invoices'), (snap) => {
      setInvoices(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).filter((i: any) => !i._deleted));
      invLoaded = true; checkDone();
    }, () => { invLoaded = true; checkDone(); });

    const unsubOrd = onSnapshot(collection(db, 'merchants', user.uid, 'orders'), (snap) => {
      setOrders(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).filter((o: any) => o.status !== 'Cancelled'));
      ordLoaded = true; checkDone();
    }, () => { ordLoaded = true; checkDone(); });

    const unsubPos = onSnapshot(collection(db, 'merchants', user.uid, 'pos_sales'), (snap) => {
      setPosSales(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).filter((s: any) => !s._deleted));
      posLoaded = true; checkDone();
    }, () => { posLoaded = true; checkDone(); });

    const unsubCust = onSnapshot(collection(db, 'merchants', user.uid, 'customers'), (snap) => {
      setManualCustomers(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).filter((c: any) => !c._deleted));
      custLoaded = true; checkDone();
    }, () => { custLoaded = true; checkDone(); });

    return () => { unsubInv(); unsubPos(); unsubCust(); unsubOrd(); };
  }, [user?.uid]);

  const aggregated: AggregatedCustomer[] = (() => {
    const map = new Map<string, AggregatedCustomer>();

    invoices.forEach(inv => {
      if (!inv.customerName?.trim()) return;
      const key = normalizeName(inv.customerName);
      const total = inv.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
      const existing = map.get(key);
      const entry: AggregatedCustomer = existing || {
        key, name: inv.customerName.trim(), totalSpent: 0, orderCount: 0, lastDate: inv.date,
        isManualOnly: false, history: [],
      };
      entry.totalSpent += total;
      entry.orderCount += 1;
      if (inv.date > entry.lastDate) entry.lastDate = inv.date;
      if (inv.customerPhone) entry.phone = inv.customerPhone;
      if (inv.customerEmail) entry.email = inv.customerEmail;
      entry.history.push({ source: 'Invoice', label: inv.invoiceNumber, amount: total, date: inv.date });
      map.set(key, entry);
    });

    posSales.forEach(sale => {
      if (!sale.customerName?.trim()) return;
      const key = normalizeName(sale.customerName);
      const existing = map.get(key);
      const entry: AggregatedCustomer = existing || {
        key, name: sale.customerName.trim(), totalSpent: 0, orderCount: 0, lastDate: sale.date,
        isManualOnly: false, history: [],
      };
      entry.totalSpent += sale.total;
      entry.orderCount += 1;
      if (sale.date > entry.lastDate) entry.lastDate = sale.date;
      entry.history.push({ source: 'POS', label: `${sale.items.length} item${sale.items.length > 1 ? 's' : ''} (${sale.paymentMethod})`, amount: sale.total, date: sale.date });
      map.set(key, entry);
    });

    orders.forEach(order => {
      if (order.status === 'Pending' || !order.customerName?.trim()) return;
      const key = normalizeName(order.customerName);
      const orderDate = order.createdAt?.slice(0, 10) || '';
      const existing = map.get(key);
      const entry: AggregatedCustomer = existing || {
        key, name: order.customerName.trim(), totalSpent: 0, orderCount: 0, lastDate: orderDate,
        isManualOnly: false, history: [],
      };
      entry.totalSpent += order.total;
      entry.orderCount += 1;
      if (orderDate > entry.lastDate) entry.lastDate = orderDate;
      if (order.customerPhone) entry.phone = order.customerPhone;
      if (order.customerEmail) entry.email = order.customerEmail;
      entry.history.push({ source: 'Order', label: `${order.items?.length || 0} item${(order.items?.length || 0) > 1 ? 's' : ''} online (${order.paymentMethod})`, amount: order.total, date: orderDate });
      map.set(key, entry);
    });

    manualCustomers.forEach(mc => {
      const key = normalizeName(mc.name);
      const existing = map.get(key);
      if (existing) {
        existing.phone = existing.phone || mc.phone;
        existing.email = existing.email || mc.email;
        existing.notes = mc.notes;
        existing.manualId = mc.id;
      } else {
        map.set(key, {
          key, name: mc.name, phone: mc.phone, email: mc.email, notes: mc.notes,
          totalSpent: 0, orderCount: 0, lastDate: mc.createdAt.slice(0, 10),
          isManualOnly: true, manualId: mc.id, history: [],
        });
      }
    });

    return Array.from(map.values())
      .sort((a, b) => b.totalSpent - a.totalSpent)
      .map(c => ({ ...c, history: c.history.sort((x, y) => y.date.localeCompare(x.date)), segments: segmentsMap[c.key] || [] }));
  })();

  const allSegments = Array.from(new Set(Object.values(segmentsMap).flat())).sort();

  const filtered = aggregated
    .filter(c => c.name.toLowerCase().includes(search.toLowerCase()))
    .filter(c => !activeSegmentFilter || (c.segments || []).includes(activeSegmentFilter));

  const avatarColors = [C.navy, C.blue, C.green, C.orange, C.purple];

  const handleAddCustomer = async (data: { name: string; phone?: string; email?: string; notes?: string }) => {
    if (!user?.uid) {
      setAddError('You are not signed in. Please log in again.');
      return;
    }
    const record: CustomerRecord = {
      id: Date.now().toString(),
      name: data.name,
      phone: data.phone,
      email: data.email,
      notes: data.notes,
      createdAt: new Date().toISOString(),
    };
    await setDoc(doc(db, 'merchants', user.uid, 'customers', record.id), record);
    setShowAddForm(false);
  };

  const handleDeleteManual = async () => {
    if (!user?.uid || !selected?.manualId) return;
    await setDoc(doc(db, 'merchants', user.uid, 'customers', selected.manualId), { _deleted: true }, { merge: true });
    setSelected(null);
  };

  if (selected) {
    return <CustomerDetailScreen customer={selected} onBack={() => setSelected(null)} onDeleteManual={selected.isManualOnly ? handleDeleteManual : undefined} allSegments={allSegments} />;
  }

  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 32px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ color: 'white', fontSize: 22, fontWeight: 700 }}>Customers</h2>
          <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 4 }}>{aggregated.length} total customer{aggregated.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={() => { setShowAddForm(true); setAddError(''); }} style={{ background: C.green, border: 'none', borderRadius: 12, width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <Plus size={20} color="white" />
        </button>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: C.bg, borderRadius: 12, padding: '12px 16px', marginBottom: 14 }}>
          <Search size={16} color={C.gray} />
          <input style={{ background: 'transparent', border: 'none', outline: 'none', fontSize: 14, color: C.dark, flex: 1 }} placeholder="Search customers..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        {allSegments.length > 0 && (
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto' as const, paddingBottom: 4, marginBottom: 16 }}>
            <button onClick={() => setActiveSegmentFilter(null)} style={{ background: !activeSegmentFilter ? C.navy : C.bg, color: !activeSegmentFilter ? 'white' : C.gray, border: 'none', borderRadius: 20, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const, flexShrink: 0 }}>All</button>
            {allSegments.map(s => (
              <button key={s} onClick={() => setActiveSegmentFilter(s)} style={{ background: activeSegmentFilter === s ? C.navy : C.bg, color: activeSegmentFilter === s ? 'white' : C.gray, border: 'none', borderRadius: 20, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const, flexShrink: 0 }}>{s}</button>
            ))}
          </div>
        )}

        {loading && (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray, fontSize: 14 }}>Loading customers...</div>
        )}

        {!loading && filtered.length === 0 && (
          <div style={{ textAlign: 'center' as const, padding: '40px 0', color: C.gray, fontSize: 14 }}>
            <Users size={32} color={C.border} style={{ marginBottom: 12 }} />
            <p>{aggregated.length === 0 ? 'No customers yet. They will appear here from invoices and sales, or tap + to add one.' : 'No customers match your search.'}</p>
          </div>
        )}

        {filtered.map((customer, i) => (
          <div key={customer.key} onClick={() => setSelected(customer)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 46, height: 46, borderRadius: '50%', background: avatarColors[i % avatarColors.length], display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, color: 'white' }}>{customer.name[0]?.toUpperCase()}</div>
              <div>
                <p style={{ fontSize: 15, fontWeight: 600, color: C.dark, marginBottom: 4 }}>{customer.name}</p>
                <p style={{ fontSize: 13, color: C.gray, marginBottom: customer.segments?.length ? 4 : 0 }}>{customer.orderCount} order{customer.orderCount !== 1 ? 's' : ''}</p>
                {customer.segments && customer.segments.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
                    {customer.segments.map(s => (
                      <span key={s} style={{ background: C.purpleLight, color: C.purple, fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20 }}>{s}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <p style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>{NAIRA}{customer.totalSpent.toLocaleString()}</p>
          </div>
        ))}
      </div>

      {showAddForm && (
        <CustomerFormModal onSave={handleAddCustomer} onCancel={() => setShowAddForm(false)} />
      )}
      {addError && (
        <div style={{ position: 'fixed' as const, bottom: 90, left: 20, right: 20, background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const, zIndex: 250 }}>{addError}</div>
      )}
    </div>
  );
}

const MORE_MENU_GROUPS: { heading: string; items: { Icon: any; label: string; sub: string; action: string }[] }[] = [
  {
    heading: 'Insights',
    items: [
      { Icon: TrendingUp, label: 'Analytics', sub: 'Best sellers, profit, and customer insights', action: 'analytics' },
      { Icon: BarChart3, label: 'Reports', sub: 'Download sales and expense reports', action: 'reports' },
    ],
  },
  {
    heading: 'Business Operations',
    items: [
      { Icon: ShoppingBag, label: 'Point of Sale', sub: 'Record offline / in-person sales', action: 'pos' },
      { Icon: FileText, label: 'Invoices', sub: 'Create and manage customer invoices', action: 'invoices' },
      { Icon: Users, label: 'Staff Accounts', sub: 'Manage your team members', action: 'staff' },
      { Icon: Wallet, label: 'Expenses', sub: 'Track money spent on your business', action: 'expenses' },
    ],
  },
  {
    heading: 'Sales & Marketing',
    items: [
      { Icon: Tag, label: 'Coupons & Discounts', sub: 'Create and manage discount codes', action: 'coupons' },
      { Icon: Package, label: 'Bundles', sub: 'Package products together at a discount', action: 'bundles' },
      { Icon: Star, label: 'Customer Reviews', sub: 'See and moderate product ratings', action: 'reviews' },
      { Icon: Megaphone, label: 'Announcement Banner', sub: 'Show a message at the top of your store', action: 'announcement' },
      { Icon: Clock, label: 'Sale Countdown Timer', sub: 'Add urgency with a ticking countdown', action: 'sale-countdown' },
      { Icon: Clock, label: 'Cart Timer', sub: 'Encourage customers to complete checkout', action: 'cart-timer' },
      { Icon: ExternalLink, label: 'Connected Tools', sub: 'Facebook Pixel, Google Analytics, and more', action: 'connected-tools' },
    ],
  },
  {
    heading: 'Store Setup',
    items: [
      { Icon: Store, label: 'My Store', sub: 'View your storefront', action: 'store' },
      { Icon: CheckCircle2, label: 'Complete Your Store', sub: 'Finish setting up your store details', action: 'complete-store' },
      { Icon: Share2, label: 'Share My Store', sub: 'Send your store link to customers', action: 'share-store' },
      { Icon: Sparkles, label: 'Brand Studio', sub: 'Customize your store theme', action: 'brand-studio' },
      { Icon: ShoppingBag, label: 'Selling Style', sub: 'Change how you sell, online or in person', action: 'selling-mode' },
    ],
  },
  {
    heading: 'Checkout & Delivery',
    items: [
      { Icon: Truck, label: 'Shipping Rates', sub: 'Set delivery fees by state', action: 'shipping-rates' },
      { Icon: Truck, label: 'Delivery Couriers', sub: 'Let customers pick a courier at checkout', action: 'couriers' },
      { Icon: FileText, label: 'Checkout Fields', sub: 'Ask customers your own custom questions', action: 'checkout-fields' },
      { Icon: FileText, label: 'Terms & Conditions', sub: 'Set your store policy for checkout', action: 'terms' },
    ],
  },
  {
    heading: 'Account',
    items: [
      { Icon: Settings, label: 'Settings', sub: 'Account & store settings', action: 'settings' },
      { Icon: HelpCircle, label: 'Help & Support', sub: 'Get help anytime', action: 'help' },
    ],
  },
];

function MoreScreen({ logout, user, onNavigate }: any) {
  const { updateProfile } = useAuth();
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState('');

  const handleProfilePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user?.uid) return;
    if (!file.type.startsWith('image/')) {
      setPhotoError('Please choose an image file.');
      return;
    }
    setPhotoError('');
    setUploadingPhoto(true);
    try {
      const compressed = await compressImage(file, 400, 0.85);
      const url = await uploadToCloudinary(compressed, `profile-photos/${user.uid}`);
      await updateProfile({ profilePhotoUrl: url });
    } catch (err: any) {
      setPhotoError('Could not upload your photo. Please check your connection and try again.');
    } finally {
      setUploadingPhoto(false);
    }
  };

  let subscriptionLabel = 'Manage your plan';
  const subActive = user?.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt).getTime() > Date.now();
  if (subActive) {
    subscriptionLabel = `${user.plan === 'pro' ? 'Growth' : 'Starter'} active`;
  } else if (user?.trialStart) {
    const elapsedDays = Math.floor((Date.now() - new Date(user.trialStart).getTime()) / (1000 * 60 * 60 * 24));
    const daysLeft = Math.max(14 - elapsedDays, 0);
    subscriptionLabel = daysLeft > 0 ? `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left on trial` : 'Trial ended - upgrade now';
  }
  const isPro = isProAccess(user);
  const handleItemClick = (action: string) => {
    if (action === 'store') {
      if (!user?.storeSlug) return;
      window.open(`${window.location.origin}/${user.storeSlug}`, '_blank');
      return;
    }
    if (action === 'share-store') {
      if (!user?.storeSlug) return;
      const link = `${window.location.origin}/${user.storeSlug}`;
      copyToClipboard(link);
      if (navigator.share) {
        navigator.share({ title: user.storeName || 'My Store', text: `Check out my store, ${user.storeName || ''}!`, url: link }).catch(() => {});
      }
      return;
    }
    if (PRO_ONLY_ACTIONS.includes(action) && !isPro) {
      onNavigate?.('subscription');
      return;
    }
    onNavigate?.(action);
  };
  return (
    <div style={{ background: C.bg, minHeight: '100vh', paddingBottom: 80, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <label style={{ position: 'relative' as const, cursor: 'pointer', flexShrink: 0 }}>
            <div style={{ width: 60, height: 60, borderRadius: '50%', background: C.green, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 700, color: 'white', border: '3px solid rgba(255,255,255,0.3)', overflow: 'hidden' }}>
              {uploadingPhoto ? (
                <div style={{ width: 20, height: 20, border: '2.5px solid rgba(255,255,255,0.4)', borderTopColor: 'white', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              ) : user?.profilePhotoUrl ? (
                <img src={user.profilePhotoUrl} alt={user?.name || 'Profile'} style={{ width: '100%', height: '100%', objectFit: 'cover' as const }} />
              ) : (
                user?.name?.[0] || 'M'
              )}
            </div>
            <div style={{ position: 'absolute' as const, bottom: -2, right: -2, width: 22, height: 22, borderRadius: '50%', background: C.white, border: `2px solid ${C.navy}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Camera size={11} color={C.navy} />
            </div>
            <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleProfilePhotoSelect} />
          </label>
          <div>
            <h3 style={{ color: 'white', fontSize: 18, fontWeight: 700, marginBottom: 4 }}>{user?.storeName || user?.name || 'Merchant'}</h3>
            <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>{user?.email || 'merchant@gmail.com'}</p>
          </div>
        </div>
        {photoError && <p style={{ color: '#FCA5A5', fontSize: 12, marginTop: 8 }}>{photoError}</p>}
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
      <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -20, padding: 20 }}>

        <button onClick={() => onNavigate?.('subscription')} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 14, background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 16, padding: 18, cursor: 'pointer', marginBottom: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.05)' }}>
          <div style={{ width: 46, height: 46, background: C.bg, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Rocket size={21} color={C.navy} />
          </div>
          <div style={{ flex: 1, textAlign: 'left' as const }}>
            <p style={{ fontSize: 15, fontWeight: 700, color: C.dark, marginBottom: 2 }}>Upgrade your account</p>
            <p style={{ fontSize: 12.5, color: C.gray }}>{subscriptionLabel}</p>
          </div>
          <ChevronRight size={18} color={C.gray} />
        </button>

        {MORE_MENU_GROUPS.map(group => {
          const groupItems = group.heading === 'Account' && isOwner(user)
            ? [...group.items, { Icon: ShieldCheck, label: 'Owner Dashboard', sub: 'Merchants, revenue, and usage', action: 'owner-dashboard' }]
            : group.items;
          const visibleItems = groupItems.filter(item => canAccessMoreAction(user, item.action));
          if (visibleItems.length === 0) return null;
          return (
            <div key={group.heading} style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 11.5, fontWeight: 800, color: C.gray, textTransform: 'uppercase' as const, letterSpacing: 0.6, marginBottom: 8 }}>{group.heading}</p>
              {visibleItems.map(item => {
                const locked = PRO_ONLY_ACTIONS.includes(item.action) && !isPro;
                return (
                  <div key={item.label} onClick={() => handleItemClick(item.action)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}>
                    <div style={{ width: 44, height: 44, background: C.bg, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><item.Icon size={19} color={C.navy} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <p style={{ fontSize: 14.5, fontWeight: 600, color: C.dark, marginBottom: 2 }}>{item.label}</p>
                        {locked && <span style={{ background: C.navy, color: 'white', fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 20, letterSpacing: 0.3, flexShrink: 0 }}>GROWTH</span>}
                      </div>
                      <p style={{ fontSize: 12.5, color: C.gray }}>{item.sub}</p>
                    </div>
                    <ChevronRight size={18} color={C.gray} />
                  </div>
                );
              })}
            </div>
          );
        })}

        <button onClick={logout} style={{ background: '#FEE2E2', color: '#EF4444', border: 'none', borderRadius: 14, padding: 16, fontSize: 15, fontWeight: 700, cursor: 'pointer', width: '100%', marginTop: 4 }}>Logout</button>
      </div>
    </div>
  );
}

function Dashboard() {
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState('dashboard');
  const [moreView, setMoreView] = useState<string | null>(null);

  // A push notification only shows up automatically in the phone's notification tray when the
  // app is closed or in the background - the service worker handles that case. When the app is
  // open (on any screen, not just Settings), nothing shows a notification unless the app itself
  // is listening for the message and displays it manually. This is that missing piece. Uses the
  // service worker's own showNotification() rather than the plain Notification constructor -
  // Android Chrome specifically blocks calling `new Notification()` directly from the page.
  useEffect(() => {
    if (!user?.fcmTokens || user.fcmTokens.length === 0 || !('Notification' in window) || !('serviceWorker' in navigator)) return;
    let unsubscribe: (() => void) | undefined;
    (async () => {
      try {
        const { getMessaging, onMessage } = await import('firebase/messaging');
        const messaging = getMessaging();
        const registration = await navigator.serviceWorker.getRegistration('/firebase-messaging-sw.js');
        unsubscribe = onMessage(messaging, (payload) => {
          const title = payload.notification?.title || 'SalesPilot';
          const body = payload.notification?.body || '';
          if (Notification.permission === 'granted' && registration) {
            registration.showNotification(title, { body, icon: PLATFORM_LOGO_URL || undefined });
          }
        });
      } catch {}
    })();
    return () => { if (unsubscribe) unsubscribe(); };
  }, [user?.uid, user?.fcmTokens?.length]);

  const handleDashboardNavigate = (action: string) => {
    if (action === 'products' || action === 'orders' || action === 'customers') {
      setActiveTab(action);
      return;
    }
    if (action === 'store') {
      if (!user?.storeSlug) return;
      window.open(`${window.location.origin}/${user.storeSlug}`, '_blank');
      return;
    }
    if (action === 'share-store') {
      if (!user?.storeSlug) return;
      const link = `${window.location.origin}/${user.storeSlug}`;
      copyToClipboard(link);
      if (navigator.share) {
        navigator.share({ title: user.storeName || 'My Store', text: `Check out my store, ${user.storeName || ''}!`, url: link }).catch(() => {});
      }
      return;
    }
    setMoreView(action);
  };

  if (moreView && !canAccessMoreAction(user, moreView)) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' as const, fontFamily: 'Inter, sans-serif', background: C.bg }}>
        <AlertCircle size={28} color={C.gray} style={{ marginBottom: 10 }} />
        <p style={{ fontSize: 14, fontWeight: 700, color: C.dark, marginBottom: 6 }}>You don't have access to this section</p>
        <button onClick={() => setMoreView(null)} style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 12, padding: '10px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer', marginTop: 8 }}>Go Back</button>
      </div>
    );
  }

  if (moreView === 'coupons') {
    return <CouponsScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'bundles') {
    return <BundlesScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'announcement') {
    return <AnnouncementScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'sale-countdown') {
    return <SaleCountdownScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'cart-timer') {
    return <CartTimerScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'connected-tools') {
    return <ConnectedToolsScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'shipping-rates') {
    return <ShippingRatesScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'couriers') {
    return <CouriersScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'checkout-fields') {
    return <CheckoutFieldsScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'terms') {
    return <TermsScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'selling-mode') {
    return <SellingModeScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'settings') {
    return <SettingsScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'help') {
    return <HelpSupportScreen onBack={() => setMoreView(null)} onNavigate={(action) => { setMoreView(null); setActiveTab(action); }} />;
  }
  if (moreView === 'owner-dashboard') {
    return isOwner(user) ? <OwnerDashboardScreen onBack={() => setMoreView(null)} /> : null;
  }
  if (moreView === 'email-campaign') {
    return <EmailCampaignScreen onBack={() => setMoreView(null)} onNavigate={(action) => setMoreView(action)} />;
  }
  if (moreView === 'buy-credits') {
    return <BuyCreditsScreen onBack={() => setMoreView('email-campaign')} />;
  }
  if (moreView === 'reviews') {
    return <ReviewsScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'expenses') {
    return <ExpensesScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'complete-store') {
    return <CompleteStoreScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'reports') {
    return <ReportsScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'analytics') {
    return <AnalyticsScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'brand-studio') {
    return <BrandStudioScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'invoices') {
    return <InvoiceScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'pos') {
    return <POSScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'staff') {
    return <StaffScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'subscription') {
    return <SubscriptionScreen onBack={() => setMoreView(null)} />;
  }
  if (moreView === 'notifications') {
    return <NotificationsScreen onBack={() => setMoreView(null)} />;
  }

  return (
    <div>
      {activeTab === 'dashboard' && canAccessTab(user, 'dashboard') && <DashboardScreen user={user} onNavigate={handleDashboardNavigate} />}
      {activeTab === 'orders' && canAccessTab(user, 'orders') && <OrdersScreen />}
      {activeTab === 'products' && canAccessTab(user, 'products') && <ProductsScreen />}
      {activeTab === 'customers' && canAccessTab(user, 'customers') && <CustomersScreen />}
      {activeTab === 'more' && canAccessTab(user, 'more') && <MoreScreen logout={logout} user={user} onNavigate={(action: string) => setMoreView(action)} />}
      {!canAccessTab(user, activeTab) && (
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' as const, fontFamily: 'Inter, sans-serif' }}>
          <AlertCircle size={28} color={C.gray} style={{ marginBottom: 10 }} />
          <p style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>You don't have access to this section</p>
        </div>
      )}
      <BottomNav active={activeTab} setActive={setActiveTab} user={user} />
    </div>
  );
}

// A small reusable "Continue with X" button for social sign-in. Uses a plain circular
// monogram instead of the real Google/Apple logos, since those are trademarked assets, not
// generic icons available to use freely.
function SocialSignInButton({ label, monogram, monogramBg, monogramColor, onClick, disabled }: { label: string; monogram: string; monogramBg: string; monogramColor: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 14, padding: 14, fontSize: 14.5, fontWeight: 700, color: C.dark, cursor: 'pointer', opacity: disabled ? 0.6 : 1 }}
    >
      <div style={{ width: 22, height: 22, borderRadius: '50%', background: monogramBg, color: monogramColor, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, flexShrink: 0 }}>{monogram}</div>
      {label}
    </button>
  );
}

function OrDivider() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0' }}>
      <div style={{ flex: 1, height: 1, background: C.border }} />
      <span style={{ fontSize: 12, color: C.gray, fontWeight: 600 }}>or</span>
      <div style={{ flex: 1, height: 1, background: C.border }} />
    </div>
  );
}

function Signup() {
  const { signup, loginWithGoogle, loginWithApple } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [referralInput, setReferralInput] = useState(() => getReferralCode());
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState('');
  const [step, setStep] = useState<'form' | 'verify'>('form');
  const [code, setCode] = useState('');
  const [sendingCode, setSendingCode] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const handle = (e: any) => setForm({ ...form, [e.target.name]: e.target.value });
  const inp = { width: '100%', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 15, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  // Sends a real 6-digit code to the email they typed, and stores it in Firestore with a 10
  // minute expiry so it can be checked back against once they enter it. No account is created
  // yet at this point - that only happens after the code is confirmed correct.
  const sendVerificationCode = async () => {
    setError('');
    if (!form.name || !form.email || !form.password) {
      setError('Please fill in all fields.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setError('Please check your email address and try again.');
      return;
    }
    if (form.password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setSendingCode(true);
    const generatedCode = Math.floor(100000 + Math.random() * 900000).toString();
    const emailKey = form.email.trim().toLowerCase();
    try {
      await setDoc(doc(db, 'emailVerifications', emailKey), {
        code: generatedCode,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
    } catch (err: any) {
      setError('Something went wrong. Please try again.');
      setSendingCode(false);
      return;
    }
    try {
      const res = await fetch('https://sales-pilot-payment.vercel.app/api/send-verification-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailKey, code: generatedCode, name: form.name }),
      });
      if (!res.ok) {
        let detail = '';
        try { const body = await res.json(); detail = extractErrorMessage(body); } catch {}
        if (detail.toLowerCase().includes('invalid') && detail.toLowerCase().includes('email')) {
          setError('Please check your email address and try again.');
        } else {
          setError("We couldn't send your verification email right now. Please try again in a moment.");
        }
        setSendingCode(false);
        return;
      }
      setStep('verify');
      setResendCooldown(30);
      trackEmailSent();
    } catch (err: any) {
      setError('Please check your internet connection and try again.');
    } finally {
      setSendingCode(false);
    }
  };

  const handleVerifyAndSignup = async () => {
    setError('');
    if (!code || code.length !== 6) {
      setError('Please enter the 6 digit code from your email.');
      return;
    }
    setVerifying(true);
    try {
      const emailKey = form.email.trim().toLowerCase();
      const snap = await getDoc(doc(db, 'emailVerifications', emailKey));
      if (!snap.exists()) {
        setError('That code has expired. Please request a new one.');
        return;
      }
      const data = snap.data() as any;
      if (Date.now() > data.expiresAt) {
        setError('That code has expired. Please request a new one.');
        return;
      }
      if (data.code !== code.trim()) {
        setError('That code is incorrect. Please check your email and try again.');
        return;
      }
      if (referralInput.trim()) {
        try { sessionStorage.setItem('sp_referral_code', referralInput.trim()); } catch {}
      }
      await signup(form.email, form.password, form.name);
    } catch (err: any) {
      if (err.code === 'auth/email-already-in-use') setError('That email is already registered. Try signing in instead.');
      else if (err.code === 'auth/invalid-email') setError('Please enter a valid email address.');
      else setError('Something went wrong. Please try again.');
    } finally {
      setVerifying(false);
    }
  };

  const handleSocial = async (provider: 'google' | 'apple') => {
    setError('');
    setSocialLoading(provider);
    if (referralInput.trim()) {
      try { sessionStorage.setItem('sp_referral_code', referralInput.trim()); } catch {}
    }
    try {
      if (provider === 'google') await loginWithGoogle();
      else await loginWithApple();
    } catch (err: any) {
      if (err.code === 'auth/popup-closed-by-user') { setSocialLoading(''); return; }
      setError('Could not sign up right now. Please try again.');
    } finally {
      setSocialLoading('');
    }
  };

  if (step === 'verify') {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Inter, sans-serif' }}>
        <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '48px 24px 80px', textAlign: 'center' as const }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 20 }}>
            <AppLogo size={44} />
            <span style={{ fontSize: 24, fontWeight: 700, color: 'white' }}>SalesPilot</span>
          </div>
          <h2 style={{ color: 'white', fontSize: 26, fontWeight: 700, marginBottom: 8 }}>Check your email</h2>
          <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14 }}>We sent a 6 digit code to {form.email}</p>
        </div>
        <div style={{ background: C.white, borderRadius: '28px 28px 0 0', marginTop: -28, padding: '28px 24px', minHeight: '60vh' }}>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
            {error && <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600 }}>{error}</div>}
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Verification code</label>
              <input
                style={{ ...inp, fontSize: 24, letterSpacing: 8, textAlign: 'center' as const, fontWeight: 700 }}
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </div>
            <button disabled={verifying} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: verifying ? 0.7 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={handleVerifyAndSignup}>
              {verifying ? 'Verifying...' : <>Verify & Create Account <ArrowRight size={16} /></>}
            </button>
            <button
              disabled={resendCooldown > 0 || sendingCode}
              onClick={sendVerificationCode}
              style={{ background: 'none', border: 'none', color: resendCooldown > 0 ? C.gray : C.navy, fontSize: 13.5, fontWeight: 600, cursor: resendCooldown > 0 ? 'default' : 'pointer', textAlign: 'center' as const }}
            >
              {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : sendingCode ? 'Sending...' : 'Resend code'}
            </button>
            <button onClick={() => { setStep('form'); setError(''); setCode(''); }} style={{ background: 'none', border: 'none', color: C.gray, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', textAlign: 'center' as const }}>
              Use a different email
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '48px 24px 80px', textAlign: 'center' as const }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 20 }}>
          <AppLogo size={44} />
          <span style={{ fontSize: 24, fontWeight: 700, color: 'white' }}>SalesPilot</span>
        </div>
        <h2 style={{ color: 'white', fontSize: 26, fontWeight: 700, marginBottom: 8 }}>Create your account</h2>
        <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14 }}>Start your 14-day free trial today</p>
      </div>
      <div style={{ background: C.white, borderRadius: '28px 28px 0 0', marginTop: -28, padding: '28px 24px', minHeight: '60vh' }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
          {error && <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>}

          <SocialSignInButton label="Continue with Google" monogram="G" monogramBg="#4285F4" monogramColor="white" disabled={!!socialLoading} onClick={() => handleSocial('google')} />
          <SocialSignInButton label="Continue with Apple" monogram="A" monogramBg={C.dark} monogramColor="white" disabled={!!socialLoading} onClick={() => handleSocial('apple')} />

          <OrDivider />

          <div><label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Full name</label><input style={inp} name="name" placeholder="Amaka Johnson" value={form.name} onChange={handle} /></div>
          <div><label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Email address</label><input style={inp} name="email" type="email" placeholder="amaka@gmail.com" value={form.email} onChange={handle} /></div>
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Password</label>
            <div style={{ position: 'relative' as const }}>
              <input style={{ ...inp, paddingRight: 46 }} name="password" type={showPassword ? 'text' : 'password'} placeholder="Min. 6 characters" value={form.password} onChange={handle} />
              <button type="button" onClick={() => setShowPassword(!showPassword)} style={{ position: 'absolute' as const, right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex' }}>
                {showPassword ? <EyeOff size={18} color={C.gray} /> : <Eye size={18} color={C.gray} />}
              </button>
            </div>
          </div>
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Referral code <span style={{ fontWeight: 400, color: C.gray }}>(optional)</span></label>
            <input style={inp} placeholder="Have a code? Enter it here" value={referralInput} onChange={e => setReferralInput(e.target.value)} />
          </div>
          <button disabled={sendingCode} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', marginTop: 8, opacity: sendingCode ? 0.7 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={sendVerificationCode}>{sendingCode ? 'Sending code...' : <>Create account <ArrowRight size={16} /></>}</button>
          <p style={{ textAlign: 'center' as const, fontSize: 14, color: C.gray }}>Already have an account? <a href="/login" style={{ color: C.navy, fontWeight: 600, textDecoration: 'none' }}>Sign in</a></p>
        </div>
      </div>
    </div>
  );
}


function Login() {
  const { loginWithPassword, loginWithGoogle, loginWithApple, resetPassword } = useAuth();
  const [form, setForm] = useState({ email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [socialLoading, setSocialLoading] = useState('');
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotError, setForgotError] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const handle = (e: any) => setForm({ ...form, [e.target.name]: e.target.value });
  const inp = { width: '100%', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 15, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };

  const handleLogin = async () => {
    setError('');
    if (!form.email || !form.password) {
      setError('Please enter your email and password.');
      return;
    }
    setLoading(true);
    try {
      await loginWithPassword(form.email, form.password);
    } catch (err: any) {
      if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') {
        setError('Incorrect email or password.');
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSocial = async (provider: 'google' | 'apple') => {
    setError('');
    setSocialLoading(provider);
    try {
      if (provider === 'google') await loginWithGoogle();
      else await loginWithApple();
    } catch (err: any) {
      if (err.code === 'auth/popup-closed-by-user') { setSocialLoading(''); return; }
      setError('Could not sign in right now. Please try again.');
    } finally {
      setSocialLoading('');
    }
  };

  const handleForgotPassword = async () => {
    setForgotError('');
    if (!forgotEmail.trim()) { setForgotError('Please enter your email address.'); return; }
    setForgotLoading(true);
    try {
      await resetPassword(forgotEmail.trim());
      setForgotSent(true);
    } catch (err: any) {
      if (err.code === 'auth/user-not-found') setForgotError('No account found with that email.');
      else if (err.code === 'auth/invalid-email') setForgotError('Please enter a valid email address.');
      else setForgotError('Something went wrong. Please try again.');
    } finally {
      setForgotLoading(false);
    }
  };

  if (forgotMode) {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Inter, sans-serif' }}>
        <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '48px 24px 80px', textAlign: 'center' as const }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 20 }}>
            <AppLogo size={44} />
            <span style={{ fontSize: 24, fontWeight: 700, color: 'white' }}>SalesPilot</span>
          </div>
          <h2 style={{ color: 'white', fontSize: 26, fontWeight: 700, marginBottom: 8 }}>Reset your password</h2>
          <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14 }}>We'll email you a link to reset it</p>
        </div>
        <div style={{ background: C.white, borderRadius: '28px 28px 0 0', marginTop: -28, padding: '28px 24px', minHeight: '60vh' }}>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
            {forgotSent ? (
              <>
                <div style={{ background: C.greenLight, color: C.green, borderRadius: 12, padding: '14px 16px', fontSize: 13.5, fontWeight: 600, lineHeight: 1.5 }}>
                  If an account exists for {forgotEmail}, a password reset link has been sent. Check your inbox and follow the link to set a new password.
                </div>
                <button style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer' }} onClick={() => { setForgotMode(false); setForgotSent(false); setForgotEmail(''); }}>Back to sign in</button>
              </>
            ) : (
              <>
                {forgotError && <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600 }}>{forgotError}</div>}
                <div><label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Email address</label><input style={inp} type="email" placeholder="amaka@gmail.com" value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} /></div>
                <button disabled={forgotLoading} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: forgotLoading ? 0.7 : 1 }} onClick={handleForgotPassword}>{forgotLoading ? 'Sending...' : 'Send reset link'}</button>
                <button style={{ background: 'none', border: 'none', color: C.gray, fontSize: 14, fontWeight: 600, cursor: 'pointer', textAlign: 'center' as const }} onClick={() => setForgotMode(false)}>Back to sign in</button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '48px 24px 80px', textAlign: 'center' as const }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 20 }}>
          <AppLogo size={44} />
          <span style={{ fontSize: 24, fontWeight: 700, color: 'white' }}>SalesPilot</span>
        </div>
        <h2 style={{ color: 'white', fontSize: 26, fontWeight: 700, marginBottom: 8 }}>Welcome back</h2>
        <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14 }}>Sign in to your store</p>
      </div>
      <div style={{ background: C.white, borderRadius: '28px 28px 0 0', marginTop: -28, padding: '28px 24px', minHeight: '60vh' }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
          {error && <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>}

          <SocialSignInButton label="Continue with Google" monogram="G" monogramBg="#4285F4" monogramColor="white" disabled={!!socialLoading} onClick={() => handleSocial('google')} />
          <SocialSignInButton label="Continue with Apple" monogram="A" monogramBg={C.dark} monogramColor="white" disabled={!!socialLoading} onClick={() => handleSocial('apple')} />

          <OrDivider />

          <div><label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Email address</label><input style={inp} name="email" type="email" placeholder="amaka@gmail.com" value={form.email} onChange={handle} /></div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: C.dark }}>Password</label>
              <button type="button" onClick={() => setForgotMode(true)} style={{ background: 'none', border: 'none', color: C.navy, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Forgot password?</button>
            </div>
            <div style={{ position: 'relative' as const }}>
              <input style={{ ...inp, paddingRight: 46 }} name="password" type={showPassword ? 'text' : 'password'} placeholder="Your password" value={form.password} onChange={handle} />
              <button type="button" onClick={() => setShowPassword(!showPassword)} style={{ position: 'absolute' as const, right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 4, display: 'flex' }}>
                {showPassword ? <EyeOff size={18} color={C.gray} /> : <Eye size={18} color={C.gray} />}
              </button>
            </div>
          </div>
          <button disabled={loading} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', marginTop: 8, opacity: loading ? 0.7 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={handleLogin}>{loading ? 'Signing in...' : <>Sign in <ArrowRight size={16} /></>}</button>
          <p style={{ textAlign: 'center' as const, fontSize: 14, color: C.gray }}>No account? <a href="/signup" style={{ color: C.navy, fontWeight: 600, textDecoration: 'none' }}>Create one free</a></p>
        </div>
      </div>
    </div>
  );
}


function StaffJoinScreen() {
  const { merchantUid, staffId, code } = useParams();
  const navigate = useNavigate();
  const [staffDoc, setStaffDoc] = useState<StaffMember | null>(null);
  const [storeName, setStoreName] = useState('');
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      if (!merchantUid || !staffId) { setNotFound(true); setLoading(false); return; }
      try {
        const staffSnap = await getDoc(doc(db, 'merchants', merchantUid, 'staff', staffId));
        const merchantSnap = await getDoc(doc(db, 'merchants', merchantUid));
        if (!staffSnap.exists() || staffSnap.data().inviteCode !== code) {
          setNotFound(true);
        } else {
          setStaffDoc({ id: staffSnap.id, ...(staffSnap.data() as any) });
          setStoreName(merchantSnap.exists() ? (merchantSnap.data() as any).storeName || 'this store' : 'this store');
        }
      } catch {
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [merchantUid, staffId, code]);

  const inp = { width: '100%', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 15, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };

  const handleJoin = async () => {
    setError('');
    if (!password || password.length < 6) { setError('Please choose a password with at least 6 characters.'); return; }
    if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    setSubmitting(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, staffDoc!.email, password);
      await setDoc(doc(db, 'staffLookup', cred.user.uid), {
        merchantUid, staffId: staffDoc!.id, role: staffDoc!.role, name: staffDoc!.name,
      });
      await setDoc(doc(db, 'merchants', merchantUid!, 'staff', staffDoc!.id), {
        status: 'active', linkedAuthUid: cred.user.uid,
      }, { merge: true });
      pushNotification(merchantUid!, `${staffDoc!.name || 'A staff member'} accepted their invite and joined your team`, 'staff-joined');
      navigate('/dashboard');
    } catch (err: any) {
      if (err.code === 'auth/email-already-in-use') {
        setError('An account with this email already exists. Try signing in instead.');
      } else {
        setError(err?.message || 'Could not create your account. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.gray, fontFamily: 'Inter, sans-serif' }}>Loading invite...</div>;
  }

  if (notFound) {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' as const, fontFamily: 'Inter, sans-serif' }}>
        <AlertCircle size={32} color={C.gray} style={{ marginBottom: 12 }} />
        <p style={{ fontSize: 15, fontWeight: 700, color: C.dark, marginBottom: 6 }}>Invite not found</p>
        <p style={{ fontSize: 13, color: C.gray }}>This invite link is invalid, expired, or has already been used. Ask the store owner to send you a new one.</p>
      </div>
    );
  }

  if (staffDoc?.status === 'active') {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' as const, fontFamily: 'Inter, sans-serif' }}>
        <CheckCircle2 size={32} color={C.green} style={{ marginBottom: 12 }} />
        <p style={{ fontSize: 15, fontWeight: 700, color: C.dark, marginBottom: 6 }}>This invite has already been used</p>
        <p style={{ fontSize: 13, color: C.gray, marginBottom: 20 }}>If this was you, just sign in with the password you already set.</p>
        <a href="/login" style={{ color: C.navy, fontWeight: 700, fontSize: 14, textDecoration: 'none' }}>Go to Sign In</a>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '48px 24px 80px', textAlign: 'center' as const }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 20 }}>
          <AppLogo size={44} />
          <span style={{ fontSize: 24, fontWeight: 700, color: 'white' }}>SalesPilot</span>
        </div>
        <h2 style={{ color: 'white', fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Join {storeName}</h2>
        <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14 }}>You're invited as {staffDoc?.role}</p>
      </div>
      <div style={{ background: C.white, borderRadius: '28px 28px 0 0', marginTop: -28, padding: '28px 24px', minHeight: '60vh' }}>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
          <div style={{ background: C.bg, borderRadius: 12, padding: '12px 14px' }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: C.dark }}>{staffDoc?.name}</p>
            <p style={{ fontSize: 12, color: C.gray }}>{staffDoc?.email}</p>
          </div>
          {error && <div style={{ background: '#FEE2E2', color: '#EF4444', borderRadius: 12, padding: '12px 14px', fontSize: 13, fontWeight: 600, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, maxWidth: '100%', boxSizing: 'border-box' as const }}>{error}</div>}
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Choose a password</label>
            <input style={inp} type="password" placeholder="At least 6 characters" value={password} onChange={e => setPassword(e.target.value)} />
          </div>
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Confirm password</label>
            <input style={inp} type="password" placeholder="Type it again" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} />
          </div>
          <button disabled={submitting} onClick={handleJoin} style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', marginTop: 8, opacity: submitting ? 0.7 : 1 }}>
            {submitting ? 'Setting up your account...' : 'Join Store'}
          </button>
        </div>
      </div>
    </div>
  );
}

const PLANS = [
  { id: 'basic', name: 'Starter', desc: 'Everything you need to run your store', prices: { quarterly: 7500, biannual: 13750, annual: 25000 }, features: ['Unlimited product listings', 'Online storefront with secure checkout', 'Automatic inventory tracking, online and offline', 'Point of Sale and branded invoices', 'Barcode scanning', 'Coupons, bundles, and cart timer tools', 'Real analytics on your sales, profit, and customers', 'Customer reviews and CRM', 'Delivery couriers and custom checkout fields', 'Order tracking and real-time notifications'], popular: false },
  { id: 'pro', name: 'Growth', desc: 'Built for growing businesses', prices: { quarterly: 15000, biannual: 27500, annual: 50000 }, features: ['Everything included in Starter', 'Staff accounts with role based permissions', 'Customer segments and groups', 'Sales by Marketing Channel analytics', 'Website visit tracking', 'Facebook Pixel and Google Analytics integration', 'Full access to all 32 brand themes', 'Free custom domain with annual billing', 'Priority customer support'], popular: true },
];

// Powers the new plan-comparison screen's collapsible feature sections, grouped the same way
// Bumpa groups theirs (Sell Online, Inventory Management, Sales Management, etc.) rather than
// one long flat list - makes it much easier to see exactly what's different between the two
// plans at a glance, one category at a time.
const PLAN_FEATURE_GROUPS: { heading: string; items: { text: string; starter: boolean; growth: boolean }[] }[] = [
  {
    heading: 'Sell Online & In Person',
    items: [
      { text: 'Online storefront with secure checkout', starter: true, growth: true },
      { text: 'Point of Sale for in-person sales', starter: true, growth: true },
      { text: 'Branded invoices', starter: true, growth: true },
      { text: 'Barcode scanning', starter: true, growth: true },
    ],
  },
  {
    heading: 'Inventory Management',
    items: [
      { text: 'Unlimited product listings', starter: true, growth: true },
      { text: 'Automatic stock tracking, online and offline', starter: true, growth: true },
      { text: 'Product bundles', starter: true, growth: true },
      { text: 'Delivery couriers at checkout', starter: true, growth: true },
      { text: 'Custom checkout questions', starter: true, growth: true },
    ],
  },
  {
    heading: 'Sales Management',
    items: [
      { text: 'Coupons and discounts', starter: true, growth: true },
      { text: 'Cart timer and sale countdown', starter: true, growth: true },
      { text: 'Customer reviews', starter: true, growth: true },
      { text: 'Order tracking for customers', starter: true, growth: true },
      { text: 'Real-time bell notifications', starter: true, growth: true },
    ],
  },
  {
    heading: 'Analytics & Insight',
    items: [
      { text: 'Real analytics on sales, profit, and customers', starter: true, growth: true },
      { text: 'Sales by Marketing Channel', starter: false, growth: true },
      { text: 'Website visit tracking', starter: false, growth: true },
      { text: 'Facebook Pixel and Google Analytics', starter: false, growth: true },
    ],
  },
  {
    heading: 'Team & Branding',
    items: [
      { text: 'Staff accounts with role permissions', starter: false, growth: true },
      { text: 'Customer segments and groups', starter: false, growth: true },
      { text: 'Full Brand Studio access, all 32 themes', starter: false, growth: true },
      { text: 'Priority customer support', starter: false, growth: true },
    ],
  },
];

const NOTIF_ICON_MAP: { [type: string]: any } = {
  'stock-low': AlertTriangle,
  'stock-out': AlertCircle,
  'staff-joined': Users,
  'new-order': ShoppingBag,
  'new-review': Star,
};

function NotificationsScreen({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.uid) return;
    const q = query(collection(db, 'merchants', user.uid, 'notifications'), orderBy('createdAt', 'desc'), fsLimit(50));
    const unsub = onSnapshot(q, (snap) => {
      setNotifications(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })));
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, [user?.uid]);

  const markRead = (id: string) => {
    if (!user?.uid) return;
    setDoc(doc(db, 'merchants', user.uid, 'notifications', id), { read: true }, { merge: true }).catch(() => {});
  };

  const markAllRead = () => {
    if (!user?.uid) return;
    notifications.filter(n => !n.read).forEach(n => markRead(n.id));
  };

  const timeAgo = (iso: string) => {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Inter, sans-serif', paddingBottom: 40 }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 9, width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <ArrowLeft size={16} color="white" />
          </button>
          <h1 style={{ color: 'white', fontSize: 18, fontWeight: 700, flex: 1 }}>Notifications</h1>
          {notifications.some(n => !n.read) && (
            <button onClick={markAllRead} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 8, padding: '6px 10px', color: 'white', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>Mark all read</button>
          )}
        </div>
      </div>
      <div style={{ padding: '16px 16px' }}>
        {loading && <p style={{ color: C.gray, fontSize: 13, textAlign: 'center' as const, padding: 30 }}>Loading...</p>}
        {!loading && notifications.length === 0 && (
          <div style={{ textAlign: 'center' as const, padding: '60px 20px' }}>
            <Bell size={32} color="#D1D5DB" style={{ marginBottom: 12 }} />
            <p style={{ fontSize: 14, color: C.gray }}>No notifications yet. We'll let you know here about low stock, new staff joining, and more.</p>
          </div>
        )}
        {notifications.map(n => {
          const Icon = NOTIF_ICON_MAP[n.type] || Bell;
          return (
            <div key={n.id} onClick={() => !n.read && markRead(n.id)} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, background: n.read ? C.white : `${C.navy}08`, borderRadius: 14, padding: 14, marginBottom: 10, cursor: n.read ? 'default' : 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon size={17} color={C.navy} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 13.5, fontWeight: n.read ? 500 : 700, color: C.dark, marginBottom: 3 }}>{n.message}</p>
                <p style={{ fontSize: 11.5, color: C.gray }}>{timeAgo(n.createdAt)}</p>
              </div>
              {!n.read && <div style={{ width: 8, height: 8, borderRadius: '50%', background: C.navy, flexShrink: 0, marginTop: 6 }} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function usePaystackScriptDashboard() {
  const [ready, setReady] = useState(() => !!(window as any).PaystackPop);
  useEffect(() => {
    if ((window as any).PaystackPop) { setReady(true); return; }
    const existing = document.getElementById('sp-paystack-script');
    if (existing) { existing.addEventListener('load', () => setReady(true)); return; }
    const script = document.createElement('script');
    script.id = 'sp-paystack-script';
    script.src = 'https://js.paystack.co/v1/inline.js';
    script.onload = () => setReady(true);
    document.body.appendChild(script);
  }, []);
  return ready;
}

const BILLING_DAYS: { [k: string]: number } = { quarterly: 90, biannual: 182, annual: 365 };

function SubscriptionScreen({ onBack }: { onBack: () => void }) {
  const { user, updateProfile } = useAuth();
  const paystackReady = usePaystackScriptDashboard();
  const [billing, setBilling] = useState<'quarterly' | 'biannual' | 'annual'>((user?.billing as any) || 'annual');
  const [selectedPlan, setSelectedPlan] = useState<'basic' | 'pro'>(user?.plan === 'pro' ? 'pro' : 'basic');
  const [activeTab, setActiveTab] = useState<'benefits' | 'purchases'>('benefits');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [recheckRef, setRecheckRef] = useState('');
  const [rechecking, setRechecking] = useState(false);
  const [recheckMsg, setRecheckMsg] = useState('');

  // Lets a merchant manually re-trigger verification for a payment that already succeeded on
  // Paystack's side but never got applied automatically (e.g. a bank transfer that confirmed a
  // few seconds after the app gave up checking). No need to pay again - just re-checks the
  // exact same reference and applies the subscription if Paystack now confirms it.
  const handleRecheck = async () => {
    setRecheckMsg('');
    if (!recheckRef.trim()) { setRecheckMsg('Please enter your payment reference.'); return; }
    setRechecking(true);
    try {
      const verifyRes = await fetch('https://sales-pilot-payment.vercel.app/api/verify-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference: recheckRef.trim() }),
      });
      const result = await verifyRes.json();
      if (result.verified) {
        const newExpiry = new Date(Date.now() + BILLING_DAYS[billing] * 24 * 60 * 60 * 1000).toISOString();
        const purchaseRecord = {
          reference: recheckRef.trim(),
          plan: selectedPlan,
          planName: activePlan.name,
          billing,
          amount: activePlan.prices[billing],
          paidAt: new Date().toISOString(),
        };
        await updateProfile({
          plan: selectedPlan,
          billing,
          subscriptionExpiresAt: newExpiry,
          lastSubscriptionReference: recheckRef.trim(),
          lastSubscriptionPaidAt: new Date().toISOString(),
          subscriptionHistory: arrayUnion(purchaseRecord),
        });
        // Only counts as a referral "conversion" the very first time this merchant ever pays -
        // a renewal isn't a new referral, so this must never double-count.
        if (user?.referredBy && (!user?.subscriptionHistory || user.subscriptionHistory.length === 0)) {
          try { await setDoc(doc(db, 'referrers', user.referredBy), { payingCount: increment(1), revenue: increment(purchaseRecord.amount) }, { merge: true }); } catch {}
        }
        setSuccess(true);
      } else {
        setRecheckMsg('Paystack has not confirmed this payment yet. If you just paid, wait a minute and try again.');
      }
    } catch (err) {
      setRecheckMsg('Could not check this payment right now. Please check your connection and try again.');
    } finally {
      setRechecking(false);
    }
  };

  const now = Date.now();
  const expiresAt = user?.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt).getTime() : null;
  const subscriptionActive = expiresAt !== null && expiresAt > now;

  let statusLabel = 'No active subscription yet';
  if (subscriptionActive) {
    statusLabel = `${user.plan === 'pro' ? 'Growth' : 'Starter'} active until ${new Date(expiresAt!).toLocaleDateString()}`;
  } else if (user?.trialStart) {
    const elapsedDays = Math.floor((now - new Date(user.trialStart).getTime()) / (1000 * 60 * 60 * 24));
    const daysLeft = Math.max(14 - elapsedDays, 0);
    statusLabel = daysLeft > 0 ? `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left on your free trial` : 'Your free trial has ended';
  }

  const activePlan = PLANS.find(p => p.id === selectedPlan)!;
  // A referred merchant gets a real 20% off their very first payment only - never a renewal.
  const referralDiscountApplies = !!user?.referredBy && (!user?.subscriptionHistory || user.subscriptionHistory.length === 0);
  const displayFullPrice = activePlan.prices[billing];
  const displayPrice = referralDiscountApplies ? Math.round(displayFullPrice * 0.8) : displayFullPrice;
  const BILLING_OPTIONS: { id: 'quarterly' | 'biannual' | 'annual'; label: string; multiplier: number }[] = [
    { id: 'quarterly', label: 'Quarterly', multiplier: 1 },
    { id: 'biannual', label: '6 Months', multiplier: 2 },
    { id: 'annual', label: 'Yearly', multiplier: 4 },
  ];

  const toggleGroup = (heading: string) => {
    const next = new Set(expandedGroups);
    if (next.has(heading)) next.delete(heading); else next.add(heading);
    setExpandedGroups(next);
  };

  const handlePay = () => {
    setError('');
    if (!paystackReady) { setError('Payment is still loading - please wait a moment and try again.'); return; }
    if (!user?.email) { setError('We could not find your account email. Please contact support.'); return; }
    // A referred merchant gets a real 20% off their very first payment - never a renewal, and
    // never a second "first payment" if they somehow had a referral code without ever paying
    // before, so this can only ever apply once per merchant, ever.
    const isFirstPayment = !user?.subscriptionHistory || user.subscriptionHistory.length === 0;
    const referralDiscountApplies = !!user?.referredBy && isFirstPayment;
    const fullPrice = activePlan.prices[billing];
    const amount = referralDiscountApplies ? Math.round(fullPrice * 0.8) : fullPrice;
    const reference = `SUB${Date.now()}`;
    setProcessing(true);
    const handler = (window as any).PaystackPop.setup({
      key: PAYSTACK_PUBLIC_KEY,
      email: user.email,
      amount: Math.round(amount * 100),
      currency: 'NGN',
      ref: reference,
      callback: (response: any) => {
        (async () => {
          // Bank transfer payments (unlike cards) can take a few extra seconds to actually
          // confirm on Paystack's side. Checking only once, immediately, risks a false "not
          // verified" result on a payment that genuinely succeeded moments later. Retry a few
          // times with a short pause before giving up.
          let result: any = null;
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              const verifyRes = await fetch('https://sales-pilot-payment.vercel.app/api/verify-payment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reference: response.reference }),
              });
              result = await verifyRes.json();
              if (result.verified) break;
            } catch (err) {
              console.error('Verification attempt failed:', err);
            }
            if (attempt < 4) await new Promise(res => setTimeout(res, 3000));
          }
          try {
            if (result?.verified) {
              const newExpiry = new Date(Date.now() + BILLING_DAYS[billing] * 24 * 60 * 60 * 1000).toISOString();
              const purchaseRecord = {
                reference: response.reference,
                plan: selectedPlan,
                planName: activePlan.name,
                billing,
                amount,
                paidAt: new Date().toISOString(),
              };
              await updateProfile({
                plan: selectedPlan,
                billing,
                subscriptionExpiresAt: newExpiry,
                lastSubscriptionReference: response.reference,
                lastSubscriptionPaidAt: new Date().toISOString(),
                subscriptionHistory: arrayUnion(purchaseRecord),
              });
              if (user?.referredBy && (!user?.subscriptionHistory || user.subscriptionHistory.length === 0)) {
                try { await setDoc(doc(db, 'referrers', user.referredBy), { payingCount: increment(1), revenue: increment(purchaseRecord.amount) }, { merge: true }); } catch {}
              }
              setSuccess(true);
            } else {
              setError(`We could not confirm your payment automatically. If money left your account, your reference is ${response.reference}, save this. Try "Recheck a Payment" below in a minute, or contact support with this reference.`);
            }
          } catch (err) {
            console.error('Subscription payment verification failed:', err);
            setError('We could not confirm your payment right now. If money left your account, please contact support with reference: ' + response.reference);
          } finally {
            setProcessing(false);
          }
        })();
      },
      onClose: () => setProcessing(false),
    });
    handler.openIframe();
  };

  if (success) {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Inter, sans-serif', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' as const }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: C.greenLight, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
          <CheckCircle2 size={32} color={C.green} />
        </div>
        <h2 style={{ fontSize: 21, fontWeight: 800, color: C.dark, marginBottom: 8 }}>Payment successful!</h2>
        <p style={{ fontSize: 13.5, color: C.gray, marginBottom: 26 }}>You're now subscribed to {selectedPlan === 'pro' ? 'Growth' : 'Starter'}.</p>
        <button onClick={onBack} style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 14, padding: '14px 28px', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>Done</button>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Inter, sans-serif', paddingBottom: 40 }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 9, width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <ArrowLeft size={16} color="white" />
          </button>
          <h1 style={{ color: 'white', fontSize: 18, fontWeight: 700 }}>Subscription</h1>
        </div>
      </div>
      <div style={{ padding: 20 }}>
        <div style={{ background: C.white, borderRadius: 14, padding: 16, marginBottom: 20, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
          <p style={{ fontSize: 12, color: C.gray, marginBottom: 4 }}>Current status</p>
          <p style={{ fontSize: 15, fontWeight: 700, color: C.dark }}>{statusLabel}</p>
        </div>

        {/* Plan segmented tabs - Starter | Growth */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 16, background: C.bg, borderRadius: 12, padding: 5 }}>
          {PLANS.map(p => (
            <button key={p.id} onClick={() => setSelectedPlan(p.id as 'basic' | 'pro')} style={{ flex: 1, position: 'relative' as const, background: selectedPlan === p.id ? C.white : 'transparent', border: 'none', padding: '12px 4px', borderRadius: 10, color: selectedPlan === p.id ? C.navy : C.gray, fontSize: 14, cursor: 'pointer', fontWeight: 700, boxShadow: selectedPlan === p.id ? '0 2px 8px rgba(0,0,0,0.08)' : 'none' }}>
              {p.name}
              {p.popular && (
                <span style={{ position: 'absolute' as const, top: -9, right: 6, background: C.green, color: 'white', fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 20 }}>Popular</span>
              )}
            </button>
          ))}
        </div>

        {/* Billing cycle radio cards - strikethrough original price + real discounted price */}
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10, marginBottom: 20 }}>
          {BILLING_OPTIONS.map(b => {
            const price = activePlan.prices[b.id];
            const originalPrice = activePlan.prices.quarterly * b.multiplier;
            const hasDiscount = originalPrice > price;
            const selected = billing === b.id;
            return (
              <button key={b.id} onClick={() => setBilling(b.id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', textAlign: 'left' as const, background: selected ? `${C.navy}0d` : C.white, border: `2px solid ${selected ? C.navy : C.border}`, borderRadius: 14, padding: '14px 16px', cursor: 'pointer', position: 'relative' as const }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${selected ? C.navy : C.border}`, background: selected ? C.navy : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {selected && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'white' }} />}
                  </div>
                  <div>
                    <p style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>{b.label}</p>
                    {b.id === 'annual' && <p style={{ fontSize: 11, color: C.green, fontWeight: 700 }}>Best Value</p>}
                  </div>
                </div>
                <div style={{ textAlign: 'right' as const }}>
                  {hasDiscount && <p style={{ fontSize: 12, color: C.gray, textDecoration: 'line-through' }}>{NAIRA}{originalPrice.toLocaleString()}</p>}
                  <p style={{ fontSize: 16, fontWeight: 800, color: C.navy }}>{NAIRA}{price.toLocaleString()}</p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Plan Benefits / Plan Purchases sub-tabs */}
        <div style={{ display: 'flex', borderBottom: `1.5px solid ${C.border}`, marginBottom: 18 }}>
          {[{ id: 'benefits', label: 'Plan Benefits' }, { id: 'purchases', label: 'Plan Purchases' }].map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id as 'benefits' | 'purchases')} style={{ flex: 1, background: 'none', border: 'none', padding: '10px 4px', fontSize: 13.5, fontWeight: 700, color: activeTab === t.id ? C.navy : C.gray, borderBottom: activeTab === t.id ? `2.5px solid ${C.navy}` : '2.5px solid transparent', cursor: 'pointer' }}>
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === 'benefits' ? (
          <div style={{ marginBottom: 24 }}>
            {PLAN_FEATURE_GROUPS.map(group => {
              const expanded = expandedGroups.has(group.heading);
              return (
                <div key={group.heading} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <button onClick={() => toggleGroup(group.heading)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', border: 'none', padding: '14px 0', cursor: 'pointer', textAlign: 'left' as const }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>{group.heading}</span>
                    <ChevronDown size={17} color={C.gray} style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease', flexShrink: 0 }} />
                  </button>
                  {expanded && (
                    <div style={{ paddingBottom: 14 }}>
                      {group.items.map(item => {
                        const included = selectedPlan === 'pro' ? item.growth : item.starter;
                        return (
                          <div key={item.text} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', opacity: included ? 1 : 0.45 }}>
                            {included ? <CheckCircle2 size={15} color={C.green} style={{ flexShrink: 0 }} /> : <X size={15} color={C.gray} style={{ flexShrink: 0 }} />}
                            <span style={{ fontSize: 13, color: C.dark }}>{item.text}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ marginBottom: 24 }}>
            {(!user?.subscriptionHistory || user.subscriptionHistory.length === 0) ? (
              <p style={{ fontSize: 13, color: C.gray, textAlign: 'center' as const, padding: '24px 0' }}>No purchases yet.</p>
            ) : (
              [...user.subscriptionHistory].reverse().map((purchase: any, i: number) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: `1px solid ${C.border}` }}>
                  <div>
                    <p style={{ fontSize: 13.5, fontWeight: 700, color: C.dark }}>{purchase.planName} - {purchase.billing}</p>
                    <p style={{ fontSize: 11.5, color: C.gray }}>{new Date(purchase.paidAt).toLocaleDateString()}</p>
                  </div>
                  <p style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>{NAIRA}{purchase.amount.toLocaleString()}</p>
                </div>
              ))
            )}
          </div>
        )}

        {error && <p style={{ color: '#EF4444', fontSize: 13, marginBottom: 14, textAlign: 'center' as const }}>{error}</p>}

        {referralDiscountApplies && (
          <div style={{ background: C.greenLight, borderRadius: 12, padding: 14, marginBottom: 14, textAlign: 'center' as const }}>
            <p style={{ fontSize: 13, fontWeight: 800, color: C.green, marginBottom: 2 }}>20% referral discount applied</p>
            <p style={{ fontSize: 12, color: C.dark }}>
              <span style={{ textDecoration: 'line-through', color: C.gray }}>{NAIRA}{displayFullPrice.toLocaleString()}</span>
              {' '}<span style={{ fontWeight: 700 }}>{NAIRA}{displayPrice.toLocaleString()}</span> for your first payment
            </p>
          </div>
        )}

        <button
          disabled={processing}
          onClick={handlePay}
          style={{ width: '100%', background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: processing ? 0.7 : 1 }}
        >
          {processing ? 'Processing...' : `Pay ${NAIRA}${displayPrice.toLocaleString()} with Paystack`}
        </button>

        <div style={{ marginTop: 24, paddingTop: 20, borderTop: `1px solid ${C.border}` }}>
          <p style={{ fontSize: 12.5, fontWeight: 700, color: C.dark, marginBottom: 4 }}>Already paid but it's not showing?</p>
          <p style={{ fontSize: 11.5, color: C.gray, marginBottom: 10 }}>Enter your payment reference and we'll check again, no need to pay twice.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={recheckRef}
              onChange={e => setRecheckRef(e.target.value)}
              placeholder="e.g. SUB1785791693652"
              style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 13, outline: 'none' }}
            />
            <button disabled={rechecking} onClick={handleRecheck} style={{ background: C.bg, color: C.navy, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: '0 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: rechecking ? 0.7 : 1 }}>
              {rechecking ? '...' : 'Recheck'}
            </button>
          </div>
          {recheckMsg && <p style={{ fontSize: 12, color: '#EF4444', marginTop: 8 }}>{recheckMsg}</p>}
        </div>
      </div>
    </div>
  );
}

// Tiered credit packages - a bigger bundle costs less per credit, same shape as most real
// prepaid-credit systems. This is a one-time purchase, separate entirely from the recurring
// Starter/Growth subscription - buying credits never changes what plan a merchant is on.
const CREDIT_PACKAGES = [
  { credits: 500, price: 2000 },
  { credits: 1000, price: 3500 },
  { credits: 2500, price: 7500 },
];

function BuyCreditsScreen({ onBack }: { onBack: () => void }) {
  const { user, updateProfile } = useAuth();
  const paystackReady = usePaystackScriptDashboard();
  const [selected, setSelected] = useState(CREDIT_PACKAGES[1]);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handlePay = () => {
    setError('');
    if (!paystackReady) { setError('Payment is still loading - please wait a moment and try again.'); return; }
    if (!user?.email) { setError('We could not find your account email. Please contact support.'); return; }
    const reference = `CRED${Date.now()}`;
    setProcessing(true);
    const handler = (window as any).PaystackPop.setup({
      key: PAYSTACK_PUBLIC_KEY,
      email: user.email,
      amount: Math.round(selected.price * 100),
      currency: 'NGN',
      ref: reference,
      callback: (response: any) => {
        (async () => {
          try {
            const verifyRes = await fetch('https://sales-pilot-payment.vercel.app/api/verify-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reference: response.reference }),
            });
            const result = await verifyRes.json();
            if (result.verified) {
              const purchaseRecord = {
                reference: response.reference,
                credits: selected.credits,
                price: selected.price,
                paidAt: new Date().toISOString(),
              };
              await updateProfile({
                messagingCredits: (user?.messagingCredits ?? 0) + selected.credits,
                creditPurchases: arrayUnion(purchaseRecord),
              });
              setSuccess(true);
            } else {
              setError('We could not confirm your payment went through. If money left your account, please contact support with reference: ' + response.reference);
            }
          } catch (err) {
            console.error('Credit purchase verification failed:', err);
            setError('We could not confirm your payment right now. If money left your account, please contact support with reference: ' + response.reference);
          } finally {
            setProcessing(false);
          }
        })();
      },
      onClose: () => setProcessing(false),
    });
    handler.openIframe();
  };

  if (success) {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Inter, sans-serif', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' as const }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: C.greenLight, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
          <CheckCircle2 size={32} color={C.green} />
        </div>
        <h2 style={{ fontSize: 21, fontWeight: 800, color: C.dark, marginBottom: 8 }}>Credits added!</h2>
        <p style={{ fontSize: 13.5, color: C.gray, marginBottom: 26 }}>{selected.credits.toLocaleString()} credits are now available in your account.</p>
        <button onClick={onBack} style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 14, padding: '14px 28px', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>Done</button>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Inter, sans-serif', paddingBottom: 40 }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 9, width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <ArrowLeft size={16} color="white" />
          </button>
          <h1 style={{ color: 'white', fontSize: 18, fontWeight: 700 }}>Buy Credits</h1>
        </div>
      </div>
      <div style={{ padding: 20 }}>
        <div style={{ background: C.white, borderRadius: 14, padding: 16, marginBottom: 20, boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
          <p style={{ fontSize: 12, color: C.gray, marginBottom: 4 }}>Current balance</p>
          <p style={{ fontSize: 20, fontWeight: 800, color: C.dark }}>{(user?.messagingCredits ?? 0).toLocaleString()} credits</p>
        </div>

        <p style={{ fontSize: 13, color: C.gray, marginBottom: 16, lineHeight: 1.5 }}>Each email costs {CREDITS_PER_EMAIL} credits. Buying credits is separate from your subscription, a one-time payment, not recurring.</p>

        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10, marginBottom: 24 }}>
          {CREDIT_PACKAGES.map(pkg => {
            const perCredit = pkg.price / pkg.credits;
            const selectedPkg = selected.credits === pkg.credits;
            return (
              <button key={pkg.credits} onClick={() => setSelected(pkg)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', textAlign: 'left' as const, background: selectedPkg ? `${C.navy}0d` : C.white, border: `2px solid ${selectedPkg ? C.navy : C.border}`, borderRadius: 14, padding: '14px 16px', cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${selectedPkg ? C.navy : C.border}`, background: selectedPkg ? C.navy : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {selectedPkg && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'white' }} />}
                  </div>
                  <div>
                    <p style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>{pkg.credits.toLocaleString()} credits</p>
                    <p style={{ fontSize: 11, color: C.gray }}>{NAIRA}{perCredit.toFixed(1)} per credit</p>
                  </div>
                </div>
                <p style={{ fontSize: 16, fontWeight: 800, color: C.navy }}>{NAIRA}{pkg.price.toLocaleString()}</p>
              </button>
            );
          })}
        </div>

        {error && <p style={{ color: '#EF4444', fontSize: 13, marginBottom: 14, textAlign: 'center' as const }}>{error}</p>}
        <button
          disabled={processing}
          onClick={handlePay}
          style={{ width: '100%', background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', opacity: processing ? 0.7 : 1 }}
        >
          {processing ? 'Processing...' : `Pay ${NAIRA}${selected.price.toLocaleString()} with Paystack`}
        </button>
      </div>
    </div>
  );
}


const BUSINESS_STAGE_QUESTIONS: { key: string; question: string; options: string[] }[] = [
  {
    key: 'orderVolume',
    question: 'How many orders do you get in an average week?',
    options: ['Just starting out, no orders yet', '1 to 10 orders', '11 to 50 orders', 'More than 50 orders'],
  },
  {
    key: 'sellingChannel',
    question: 'How do you currently sell?',
    options: ['Mostly through WhatsApp or in person', 'Some presence on Instagram or social media', 'I already sell online somewhere else', 'I sell in multiple places at once'],
  },
  {
    key: 'teamSize',
    question: 'Are you running this alone, or with help?',
    options: ['Just me', 'Me and one or two people helping', 'A small team'],
  },
];

// Suggests which plan best fits where the merchant's business actually is right now, based on
// real, concrete answers (order volume, selling channels, team size) rather than abstract
// feature preferences - mirrors the real Bumpa pattern of recommending a plan from a short
// business profile instead of asking a brand-new user to compare feature lists cold.
function getRecommendedPlan(answers: { [key: string]: string }): 'basic' | 'pro' {
  const highVolume = answers.orderVolume === '11 to 50 orders' || answers.orderVolume === 'More than 50 orders';
  const hasHelp = answers.teamSize === 'Me and one or two people helping' || answers.teamSize === 'A small team';
  const established = answers.sellingChannel === 'I already sell online somewhere else' || answers.sellingChannel === 'I sell in multiple places at once';
  return (highVolume || hasHelp || established) ? 'pro' : 'basic';
}

function getFirstAction(answers: { [key: string]: string }, sellingMode: string): string {
  if (sellingMode === 'in-person') return 'Go to Point of Sale and record your first sale, right from your phone.';
  if (answers.teamSize && answers.teamSize !== 'Just me') return 'Add your team under More, then Staff Accounts, so everyone can start helping.';
  if (answers.orderVolume === '11 to 50 orders' || answers.orderVolume === 'More than 50 orders') return 'Check Analytics regularly to see your real sales and profit at a glance.';
  return 'Share your store link on WhatsApp or Instagram to bring in your first order.';
}

function Onboarding() {
  const { user, updateProfile } = useAuth();
  const [step, setStep] = useState(0);
  const [sellingMode, setSellingMode] = useState('');
  const [answers, setAnswers] = useState<{ [key: string]: string }>({});
  const [billing, setBilling] = useState('quarterly');
  const [planTab, setPlanTab] = useState<'basic' | 'pro'>('basic');
  const [store, setStore] = useState({ name: '', slug: '', category: '', phone: '' });
  const [prodName, setProdName] = useState('');
  const [prodPrice, setProdPrice] = useState('');
  const [prodQty, setProdQty] = useState('');
  const [prodImage, setProdImage] = useState('');
  const [uploadingProdImage, setUploadingProdImage] = useState(false);
  const [savingProduct, setSavingProduct] = useState(false);
  const [productError, setProductError] = useState('');

  const handle = (e: any) => {
    const v = e.target.value, n = e.target.name;
    setStore({ ...store, [n]: v, ...(n === 'name' ? { slug: v.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') } : {}) });
  };
  const inp = { width: '100%', padding: '14px 16px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 15, outline: 'none', boxSizing: 'border-box' as const, background: C.white, color: C.dark };
  const recommendedPlan = getRecommendedPlan(answers);
  const activePlan = PLANS.find(p => p.id === planTab)!;
  const sellsOnline = sellingMode !== 'in-person';
  const STEP_LABELS = ['Selling Style', 'Your Business', 'Store Setup', 'First Product', 'Choose Plan', "You're Live"];

  const handleProductImage = async (e: any) => {
    const file = e.target.files?.[0];
    if (!file || !user?.uid) return;
    setUploadingProdImage(true);
    try {
      const compressed = await compressImage(file, 1280, 0.75);
      const url = await uploadToCloudinary(compressed, `products/${user.uid}`);
      setProdImage(url);
    } catch (err: any) {
      setProductError(err?.message || 'Could not upload photo. Please try again.');
    } finally {
      setUploadingProdImage(false);
    }
  };

  const handleSaveFirstProduct = async () => {
    setProductError('');
    if (!prodName.trim()) { setProductError('Please give your product a name.'); return; }
    if (!prodPrice || Number(prodPrice) <= 0) { setProductError('Please enter a valid price.'); return; }
    if (!user?.uid) return;
    setSavingProduct(true);
    try {
      const id = Date.now().toString();
      const qty = prodQty ? Number(prodQty) : undefined;
      await setDoc(doc(db, 'merchants', user.uid, 'products', id), {
        id,
        name: prodName.trim(),
        price: Number(prodPrice),
        salePrice: null,
        status: qty === 0 ? 'Out of stock' : qty !== undefined && qty <= 5 ? 'Low stock' : 'In stock',
        ...(qty !== undefined ? { quantity: qty } : {}),
        badge: 'New',
        emoji: PRODUCT_ICON_KEYS[0] || 'bag',
        ...(prodImage ? { imageUrl: prodImage } : {}),
        ...(store.category ? { category: store.category } : {}),
      });
      setPlanTab(recommendedPlan);
      setStep(4);
    } catch (err: any) {
      setProductError(err?.message || 'Could not save your product. Please try again.');
    } finally {
      setSavingProduct(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Inter, sans-serif' }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '24px 24px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
          <AppLogo size={36} />
          <span style={{ fontSize: 18, fontWeight: 700, color: 'white' }}>SalesPilot</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          {STEP_LABELS.map((_, i) => (
            <div key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= step ? C.green : 'rgba(255,255,255,0.2)' }} />
          ))}
        </div>
        <p style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.75)', fontWeight: 600 }}>Step {step + 1} of {STEP_LABELS.length}: {STEP_LABELS[step]}</p>
      </div>
      <div style={{ padding: 24 }}>
        {step === 0 && (
          <div>
            <h2 style={{ fontSize: 24, color: C.dark, marginBottom: 6, marginTop: 8 }}>How do you plan to sell?</h2>
            <p style={{ color: C.gray, marginBottom: 24, fontSize: 14 }}>This just helps us set things up the right way for you. You can always change this later.</p>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10, marginBottom: 28 }}>
              {[
                { id: 'online', title: 'Online, with a store link I can share', sub: 'Customers browse and checkout on your own store link' },
                { id: 'in-person', title: 'In person only', sub: 'I sell face to face, I do not need an online store' },
                { id: 'both', title: 'Both', sub: 'I sell online and in person' },
              ].map(opt => {
                const selected = sellingMode === opt.id;
                return (
                  <button key={opt.id} onClick={() => setSellingMode(opt.id)} style={{ display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' as const, background: selected ? `${C.navy}0d` : C.white, border: `2px solid ${selected ? C.navy : C.border}`, borderRadius: 14, padding: '14px 16px', cursor: 'pointer' }}>
                    <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${selected ? C.navy : C.border}`, background: selected ? C.navy : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {selected && <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'white' }} />}
                    </div>
                    <div>
                      <p style={{ fontSize: 14, fontWeight: 700, color: C.dark, marginBottom: 2 }}>{opt.title}</p>
                      <p style={{ fontSize: 12, color: C.gray }}>{opt.sub}</p>
                    </div>
                  </button>
                );
              })}
            </div>
            <button
              disabled={!sellingMode}
              style={{ width: '100%', background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: !sellingMode ? 0.5 : 1 }}
              onClick={() => setStep(1)}
            >
              Continue <ArrowRight size={16} />
            </button>
          </div>
        )}
        {step === 1 && (
          <div>
            <h2 style={{ fontSize: 24, color: C.dark, marginBottom: 6, marginTop: 8 }}>Tell us about your business</h2>
            <p style={{ color: C.gray, marginBottom: 24, fontSize: 14 }}>This helps us recommend the right plan for you. It takes less than a minute.</p>
            {BUSINESS_STAGE_QUESTIONS.map(q => (
              <div key={q.key} style={{ marginBottom: 22 }}>
                <p style={{ fontSize: 14, fontWeight: 700, color: C.dark, marginBottom: 10 }}>{q.question}</p>
                <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
                  {q.options.map(opt => {
                    const selected = answers[q.key] === opt;
                    return (
                      <button key={opt} onClick={() => setAnswers({ ...answers, [q.key]: opt })} style={{ display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' as const, background: selected ? `${C.navy}0d` : C.white, border: `2px solid ${selected ? C.navy : C.border}`, borderRadius: 12, padding: '12px 14px', cursor: 'pointer' }}>
                        <div style={{ width: 18, height: 18, borderRadius: '50%', border: `2px solid ${selected ? C.navy : C.border}`, background: selected ? C.navy : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          {selected && <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'white' }} />}
                        </div>
                        <span style={{ fontSize: 13.5, fontWeight: 600, color: C.dark }}>{opt}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 12 }}>
              <button style={{ background: C.bg, border: 'none', borderRadius: 14, padding: 16, fontSize: 15, fontWeight: 600, color: C.gray, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: 56 }} onClick={() => setStep(0)}><ArrowLeft size={16} /></button>
              <button
                disabled={Object.keys(answers).length < BUSINESS_STAGE_QUESTIONS.length}
                style={{ flex: 1, background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: Object.keys(answers).length < BUSINESS_STAGE_QUESTIONS.length ? 0.5 : 1 }}
                onClick={() => setStep(2)}
              >
                Continue <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}
        {step === 2 && (
          <div>
            <h2 style={{ fontSize: 24, color: C.dark, marginBottom: 6, marginTop: 8 }}>{sellsOnline ? 'Set up your store' : 'Set up your business'}</h2>
            <p style={{ color: C.gray, marginBottom: 28, fontSize: 14 }}>{sellsOnline ? 'This is what your customers will see' : 'This is used on your invoices and receipts'}</p>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>{sellsOnline ? 'Store name' : 'Business name'}</label><input style={inp} name="name" placeholder="e.g. Amaka Boutique" value={store.name} onChange={handle} /></div>
              {sellsOnline && (
                <div><label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Store URL</label>
                  <div style={{ display: 'flex', border: `1.5px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
                    <span style={{ padding: '14px 10px', fontSize: 12, color: C.gray, background: C.bg, borderRight: `1px solid ${C.border}`, whiteSpace: 'nowrap' as const }}>{window.location.host}/</span>
                    <input style={{ background: C.white, border: 'none', padding: '14px 12px', color: C.navy, fontSize: 14, flex: 1, outline: 'none', fontWeight: 600 }} name="slug" value={store.slug} onChange={handle} placeholder="amaka-boutique" />
                  </div>
                </div>
              )}
              <div><label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>What do you sell?</label>
                <select style={{ ...inp, appearance: 'none' } as any} name="category" value={store.category} onChange={handle}>
                  <option value="">Select a category</option>
                  {['Fashion & Clothing', 'Electronics & Gadgets', 'Beauty & Skincare', 'Food & Groceries', 'Home & Furniture', 'Health & Wellness', 'Other'].map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>WhatsApp / Phone</label><input style={inp} name="phone" placeholder="08012345678" value={store.phone} onChange={handle} /></div>
              <div style={{ display: 'flex', gap: 12 }}>
                <button style={{ background: C.bg, border: 'none', borderRadius: 14, padding: 16, fontSize: 15, fontWeight: 600, color: C.gray, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: 56 }} onClick={() => setStep(1)}><ArrowLeft size={16} /></button>
                <button
                  style={{ flex: 1, background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  onClick={async () => {
                    if (store.name && store.category && store.phone && user?.uid) {
                      const autoSlug = store.slug || store.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                      await updateProfile({ storeName: store.name, storeSlug: autoSlug, category: store.category, phone: store.phone, sellingMode });
                      setStep(3);
                    }
                  }}
                >
                  Continue <ArrowRight size={16} />
                </button>
              </div>
            </div>
          </div>
        )}
        {step === 3 && (
          <div>
            <h2 style={{ fontSize: 24, color: C.dark, marginBottom: 6, marginTop: 8 }}>Add your first product</h2>
            <p style={{ color: C.gray, marginBottom: 24, fontSize: 14 }}>{sellsOnline ? "Let's get your store ready to show real products from the start." : "This gets your inventory ready so Point of Sale works from your first sale."} You can add more, and edit this one, anytime.</p>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Product photo <span style={{ color: C.gray, fontWeight: 400 }}>(optional)</span></label>
                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: 140, borderRadius: 14, border: `1.5px dashed ${C.border}`, background: C.white, cursor: 'pointer', overflow: 'hidden' }}>
                  {uploadingProdImage ? (
                    <p style={{ fontSize: 13, color: C.gray }}>Uploading...</p>
                  ) : prodImage ? (
                    <img src={prodImage} alt="Product" style={{ width: '100%', height: '100%', objectFit: 'cover' as const }} />
                  ) : (
                    <div style={{ textAlign: 'center' as const }}>
                      <Camera size={22} color={C.gray} style={{ marginBottom: 6 }} />
                      <p style={{ fontSize: 12.5, color: C.gray }}>Tap to add a photo</p>
                    </div>
                  )}
                  <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleProductImage} />
                </label>
              </div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Product name</label><input style={inp} placeholder="e.g. Classic Senator Wear" value={prodName} onChange={e => setProdName(e.target.value)} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Price</label><input style={inp} type="number" placeholder="0" value={prodPrice} onChange={e => setProdPrice(e.target.value)} /></div>
              <div><label style={{ fontSize: 13, fontWeight: 600, color: C.dark, display: 'block', marginBottom: 8 }}>Quantity in stock <span style={{ color: C.gray, fontWeight: 400 }}>(optional)</span></label><input style={inp} type="number" placeholder="e.g. 10" value={prodQty} onChange={e => setProdQty(e.target.value)} /></div>
              {productError && <p style={{ color: '#EF4444', fontSize: 12.5 }}>{productError}</p>}
              <div style={{ display: 'flex', gap: 12 }}>
                <button style={{ background: C.bg, border: 'none', borderRadius: 14, padding: 16, fontSize: 15, fontWeight: 600, color: C.gray, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: 56 }} onClick={() => setStep(2)}><ArrowLeft size={16} /></button>
                <button disabled={savingProduct} style={{ flex: 1, background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: savingProduct ? 0.7 : 1 }} onClick={handleSaveFirstProduct}>
                  {savingProduct ? 'Saving...' : 'Continue'} <ArrowRight size={16} />
                </button>
              </div>
            </div>
          </div>
        )}
        {step === 4 && (
          <div>
            <h2 style={{ fontSize: 24, color: C.dark, marginBottom: 6, marginTop: 8 }}>Choose your plan</h2>
            <p style={{ color: C.gray, marginBottom: 20, fontSize: 14 }}>You can switch plans anytime from your dashboard.</p>

            <div style={{ display: 'flex', gap: 6, marginBottom: 16, background: C.bg, borderRadius: 12, padding: 5 }}>
              {[{ id: 'quarterly', label: 'Quarterly' }, { id: 'biannual', label: '6 Months' }, { id: 'annual', label: 'Yearly' }].map(b => (
                <button key={b.id} onClick={() => setBilling(b.id)} style={{ flex: 1, background: billing === b.id ? C.white : 'transparent', border: 'none', padding: '10px 4px', borderRadius: 10, color: billing === b.id ? C.navy : C.gray, fontSize: 12, cursor: 'pointer', fontWeight: 700 }}>{b.label}</button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 6, marginBottom: 20, background: C.bg, borderRadius: 12, padding: 5 }}>
              {PLANS.map(p => (
                <button key={p.id} onClick={() => setPlanTab(p.id as 'basic' | 'pro')} style={{ flex: 1, position: 'relative' as const, background: planTab === p.id ? C.white : 'transparent', border: 'none', padding: '12px 4px', borderRadius: 10, color: planTab === p.id ? C.navy : C.gray, fontSize: 14, cursor: 'pointer', fontWeight: 700, boxShadow: planTab === p.id ? '0 2px 8px rgba(0,0,0,0.08)' : 'none' }}>
                  {p.name}
                  {p.id === recommendedPlan && (
                    <span style={{ position: 'absolute' as const, top: -9, right: 6, background: C.green, color: 'white', fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 20 }}>Recommended</span>
                  )}
                </button>
              ))}
            </div>

            <div style={{ background: C.white, border: `2px solid ${C.navy}`, borderRadius: 20, padding: 22, marginBottom: 18, boxShadow: '0 4px 16px rgba(0,0,0,0.06)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                <div><h3 style={{ fontSize: 21, color: C.dark, marginBottom: 4, fontWeight: 800 }}>{activePlan.name}</h3><p style={{ fontSize: 12.5, color: C.gray }}>{activePlan.desc}</p></div>
                <div style={{ textAlign: 'right' as const }}>
                  <span style={{ fontSize: 22, fontWeight: 800, color: C.navy, display: 'block' }}>{NAIRA}{activePlan.prices[billing as keyof typeof activePlan.prices].toLocaleString()}</span>
                  <span style={{ fontSize: 11, color: C.gray }}>/{billing === 'quarterly' ? '3mo' : billing === 'biannual' ? '6mo' : 'yr'}</span>
                </div>
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {activePlan.features.map(f => <li key={f} style={{ fontSize: 13, color: C.gray, padding: '4px 0', display: 'flex', alignItems: 'flex-start' as const, gap: 8 }}><CheckCircle2 size={14} color={C.green} style={{ marginTop: 2, flexShrink: 0 }} /> {f}</li>)}
              </ul>
            </div>

            <p style={{ fontSize: 12.5, color: C.gray, textAlign: 'center' as const, marginBottom: 20, lineHeight: 1.5 }}>
              Not sure yet? Every plan includes a free 14 day trial, no payment required to get started.
            </p>

            <div style={{ display: 'flex', gap: 12 }}>
              <button style={{ background: C.bg, border: 'none', borderRadius: 14, padding: 16, fontSize: 15, fontWeight: 600, color: C.gray, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: 56 }} onClick={() => setStep(3)}><ArrowLeft size={16} /></button>
              <button style={{ flex: 1, background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 15, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={async () => { await updateProfile({ plan: planTab, billing, businessStage: answers, onboardingComplete: true, trialStart: new Date().toISOString() }); setStep(5); }}>Start free trial <ArrowRight size={16} /></button>
            </div>
          </div>
        )}
        {step === 5 && (
          <div style={{ textAlign: 'center' as const, paddingTop: 40 }}>
            <div style={{ width: 80, height: 80, background: C.greenLight, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px' }}><Rocket size={36} color={C.green} /></div>
            <h2 style={{ fontSize: 26, color: C.dark, marginBottom: 8, fontWeight: 700 }}>{sellsOnline ? 'Your store is live!' : "You're all set!"}</h2>
            <p style={{ color: C.gray, marginBottom: 28, fontSize: 14 }}>Your 14 day free trial has started, and your first product is already in your inventory.</p>
            {sellsOnline ? (
              <div style={{ display: 'flex', alignItems: 'center', background: '#F0FFF4', border: `1.5px solid ${C.green}`, borderRadius: 14, padding: '14px 16px', gap: 12, marginBottom: 20 }}>
                <span style={{ flex: 1, color: C.navy, fontSize: 14, textAlign: 'left' as const, fontWeight: 600 }}>{window.location.host}/{store.slug}</span>
                <button style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 8, padding: '8px 14px', fontWeight: 700, cursor: 'pointer', fontSize: 13 }} onClick={() => copyToClipboard(`${window.location.host}/${store.slug}`)}>Copy</button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#F0FFF4', border: `1.5px solid ${C.green}`, borderRadius: 14, padding: '14px 16px', marginBottom: 20 }}>
                <ShoppingBag size={18} color={C.green} />
                <span style={{ flex: 1, color: C.navy, fontSize: 13.5, textAlign: 'left' as const, fontWeight: 600 }}>Point of Sale is ready. No online store needed, record sales straight from your phone.</span>
              </div>
            )}
            <div style={{ background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 16, padding: 18, marginBottom: 20, textAlign: 'left' as const }}>
              <p style={{ fontSize: 12, fontWeight: 800, color: C.navy, textTransform: 'uppercase' as const, letterSpacing: 0.5, marginBottom: 6 }}>Your next step</p>
              <p style={{ fontSize: 14, fontWeight: 600, color: C.dark, lineHeight: 1.5 }}>{getFirstAction(answers, sellingMode)}</p>
            </div>
            <button style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, color: 'white', border: 'none', borderRadius: 14, padding: 16, fontSize: 16, fontWeight: 700, cursor: 'pointer', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={() => window.location.href = '/dashboard'}>Go to dashboard <ArrowRight size={16} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

// Design tokens for the public marketing/landing page specifically - a distinct visual voice
// from the merchant dashboard's navy/white palette, built around the one thing every merchant
// on this page actually cares about: a sale, recorded, wherever it happened. The signature
// device throughout is a "receipt" motif (dashed edges, monospace line items) - a real,
// physical artifact from a merchant's own world, standing in for "every sale, tracked."
const L = {
  navy: '#0F2A44',
  navyDeep: '#0A1D30',
  amber: '#E8A33D',
  amberDeep: '#C97F1E',
  paper: '#FBF6EE',
  paperDeep: '#F3ECDD',
  green: '#16A34A',
  ink: '#14181F',
  inkSoft: '#5B6472',
};

function LandingFonts() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Mono:wght@500&display=swap');
      .lp-display { font-family: 'Space Grotesk', 'Inter', sans-serif; }
      .lp-mono { font-family: 'IBM Plex Mono', monospace; }
      @keyframes lp-rise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
      .lp-rise { animation: lp-rise 0.7s cubic-bezier(0.16, 1, 0.3, 1) both; }
    `}</style>
  );
}

// The recurring torn/perforated edge - a real receipt tears here, so every section on this page
// tears into the next, reinforcing "every sale becomes part of one continuous record."
function ReceiptEdge({ color = L.paper, flip = false }: { color?: string; flip?: boolean }) {
  return (
    <div style={{
      height: 14,
      background: `linear-gradient(135deg, ${color} 50%, transparent 50%), linear-gradient(45deg, ${color} 50%, transparent 50%)`,
      backgroundSize: '20px 20px',
      backgroundPosition: flip ? 'top' : 'bottom',
      backgroundRepeat: 'repeat-x',
    }} />
  );
}

function PainSolutionRow({ eyebrow, pain, solution, imageUrl, reverse, accentColor }: { eyebrow: string; pain: string; solution: string; imageUrl: string; reverse?: boolean; accentColor: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: reverse ? 'row-reverse' : 'row', flexWrap: 'wrap' as const, alignItems: 'center', gap: 40, padding: '56px 0' }}>
      <div style={{ flex: '1 1 320px', minWidth: 280 }}>
        {imageUrl ? (
          <img src={imageUrl} alt={eyebrow} style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover' as const, borderRadius: 20, display: 'block' }} />
        ) : (
          <div style={{ width: '100%', aspectRatio: '4/3', borderRadius: 20, background: `linear-gradient(135deg, ${accentColor}22, ${L.navy}11)`, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1.5px dashed ${accentColor}55` }}>
            <p className="lp-mono" style={{ fontSize: 11, color: L.inkSoft, textAlign: 'center' as const, padding: '0 24px' }}>[ photo slot: {eyebrow.toLowerCase()} ]</p>
          </div>
        )}
      </div>
      <div style={{ flex: '1 1 360px', minWidth: 280 }}>
        <p className="lp-mono" style={{ fontSize: 11.5, fontWeight: 500, color: accentColor, letterSpacing: 1, textTransform: 'uppercase' as const, marginBottom: 10 }}>{eyebrow}</p>
        <p className="lp-display" style={{ fontSize: 22, fontWeight: 700, color: L.ink, marginBottom: 12, lineHeight: 1.3 }}>{pain}</p>
        <p style={{ fontSize: 15.5, color: L.inkSoft, lineHeight: 1.65 }}>{solution}</p>
      </div>
    </div>
  );
}

export function LandingPage() {
  const navigate = useNavigate();
  return (
    <div style={{ background: L.paper, minHeight: '100vh', fontFamily: 'Inter, sans-serif', overflowX: 'hidden' as const }}>
      <LandingFonts />

      {/* Header */}
      <div style={{ position: 'sticky' as const, top: 0, zIndex: 40, background: `${L.paper}f2`, backdropFilter: 'blur(8px)', borderBottom: `1px solid ${L.paperDeep}` }}>
        <div style={{ maxWidth: 1080, margin: '0 auto', padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <AppLogo size={30} />
            <span className="lp-display" style={{ fontSize: 17, fontWeight: 700, color: L.navy }}>SalesPilot</span>
          </div>
          <button onClick={() => navigate('/signup')} style={{ background: L.navy, color: 'white', border: 'none', borderRadius: 10, padding: '9px 18px', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>
            Get Started
          </button>
        </div>
      </div>

      {/* Hero */}
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '64px 20px 40px', display: 'flex', flexWrap: 'wrap' as const, alignItems: 'center', gap: 48 }}>
        <div style={{ flex: '1 1 380px', minWidth: 280 }} className="lp-rise">
          <p className="lp-mono" style={{ fontSize: 12, fontWeight: 500, color: L.amberDeep, letterSpacing: 1.2, textTransform: 'uppercase' as const, marginBottom: 16 }}>Built for Nigerian sellers</p>
          <h1 className="lp-display" style={{ fontSize: 'clamp(32px, 5vw, 48px)', fontWeight: 700, color: L.ink, lineHeight: 1.12, marginBottom: 20 }}>
            Every sale you make, online or in person, one business.
          </h1>
          <p style={{ fontSize: 16.5, color: L.inkSoft, lineHeight: 1.65, marginBottom: 30, maxWidth: 460 }}>
            Most sellers run two half-businesses, a shop that people can walk into, and a WhatsApp
            inbox that people can message. SalesPilot makes them one, with one stock count, one
            set of real numbers, and one place customers can actually buy from.
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const }}>
            <button onClick={() => navigate('/signup')} style={{ background: L.navy, color: 'white', border: 'none', borderRadius: 12, padding: '15px 26px', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>
              Start Free for 14 Days
            </button>
            <button onClick={() => navigate('/login')} style={{ background: 'transparent', color: L.navy, border: `1.5px solid ${L.navy}33`, borderRadius: 12, padding: '15px 26px', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>
              I already sell here
            </button>
          </div>
        </div>

        {/* Signature receipt visual */}
        <div style={{ flex: '1 1 300px', minWidth: 260, maxWidth: 340 }} className="lp-rise">
          <div style={{ background: 'white', borderRadius: 4, boxShadow: '0 24px 60px rgba(15,42,68,0.18)', padding: '28px 24px', borderTop: `3px dashed ${L.paperDeep}`, borderBottom: `3px dashed ${L.paperDeep}` }}>
            <p className="lp-mono" style={{ fontSize: 11, color: L.inkSoft, marginBottom: 16, letterSpacing: 0.5 }}>TODAY'S SALES &middot; ALL CHANNELS</p>
            {[
              { label: 'Online order', sub: 'salespilot.com.ng/nova', amt: '8,500' },
              { label: 'In-store sale', sub: 'Point of Sale', amt: '14,200' },
              { label: 'Online order', sub: 'salespilot.com.ng/nova', amt: '5,000' },
            ].map((row, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '9px 0', borderBottom: `1px dashed ${L.paperDeep}` }}>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 700, color: L.ink }}>{row.label}</p>
                  <p className="lp-mono" style={{ fontSize: 10, color: L.inkSoft }}>{row.sub}</p>
                </div>
                <p className="lp-mono" style={{ fontSize: 13, fontWeight: 500, color: L.ink }}>N{row.amt}</p>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 14, marginTop: 4 }}>
              <p className="lp-display" style={{ fontSize: 14, fontWeight: 700, color: L.navy }}>Total, synced automatically</p>
              <p className="lp-display" style={{ fontSize: 16, fontWeight: 700, color: L.green }}>N27,700</p>
            </div>
          </div>
        </div>
      </div>

      <ReceiptEdge />

      {/* Pain point strip */}
      <div style={{ background: L.navy, padding: '48px 20px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>
          <p className="lp-display" style={{ fontSize: 24, fontWeight: 700, color: 'white', marginBottom: 32, textAlign: 'center' as const }}>Why sellers actually lose sales</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 24 }}>
            {[
              { Icon: MessageCircle, text: 'A customer messages at midnight, loses interest by morning' },
              { Icon: Package, text: 'No idea what is actually left in stock right now' },
              { Icon: TrendingUp, text: 'No real sense of what is actually making money' },
              { Icon: Users, text: 'Past customers never hear from the business again' },
            ].map((p, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
                <p.Icon size={22} color={L.amber} />
                <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.85)', lineHeight: 1.5 }}>{p.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <ReceiptEdge color={L.navy} flip />

      {/* Pain -> Solution rows */}
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '20px 20px 0' }}>
        <PainSolutionRow
          eyebrow="Sell everywhere at once"
          pain="Stuck choosing between a physical shop and an online one"
          solution="A real storefront customers can buy from directly, and a Point of Sale for anyone who walks in, all pulling from the exact same stock count. Sell one item in person, it disappears from the website instantly. No more double-selling the same product."
          imageUrl={LANDING_IMAGES.onlineOffline}
          accentColor={L.navy}
        />
        <PainSolutionRow
          eyebrow="Know your real numbers"
          pain="Running the business on a feeling, not real numbers"
          solution="Real analytics on what is actually selling, what is actually making profit, and which of your marketing efforts really bring paying customers, not just page views. Make the next decision with real information instead of a guess."
          imageUrl={LANDING_IMAGES.analytics}
          reverse
          accentColor={L.green}
        />
        <PainSolutionRow
          eyebrow="Get paid, directly"
          pain="Worried about an app holding your money, or waiting days to get paid"
          solution="Customers pay straight into your own bank account. No platform holding your money, no waiting on someone else to release it, no cut taken out. What a customer pays is exactly what lands in your account."
          imageUrl={LANDING_IMAGES.delivery}
          accentColor={L.amberDeep}
        />
        <PainSolutionRow
          eyebrow="Bring back your best customers"
          pain="A great customer buys once, then you never reach them again"
          solution="See your repeat buyers, group your customers the way that actually makes sense for your business, and let real reviews build trust with the next stranger who lands on your store."
          imageUrl={LANDING_IMAGES.team}
          reverse
          accentColor={L.navy}
        />
      </div>

      <ReceiptEdge />

      {/* Feature grid */}
      <div style={{ background: L.navyDeep, padding: '56px 20px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>
          <p className="lp-display" style={{ fontSize: 24, fontWeight: 700, color: 'white', marginBottom: 8, textAlign: 'center' as const }}>Everything else, already built in</p>
          <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)', textAlign: 'center' as const, marginBottom: 36 }}>No extra tools to pay for or plug in separately</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 20 }}>
            {[
              { Icon: Camera, label: 'Barcode scanning' },
              { Icon: FileText, label: 'Branded invoices' },
              { Icon: Truck, label: 'Delivery couriers at checkout' },
              { Icon: Tag, label: 'Coupons and bundles' },
              { Icon: Clock, label: 'Sale countdown timers' },
              { Icon: Bell, label: 'Real-time sale notifications' },
              { Icon: Sparkles, label: '32 storefront themes' },
              { Icon: Users, label: 'Staff accounts with permissions' },
            ].map((f, i) => (
              <div key={i} style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 14, padding: '18px 16px', display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
                <f.Icon size={19} color={L.amber} />
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', fontWeight: 600 }}>{f.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Final CTA */}
      <div style={{ padding: '72px 20px', textAlign: 'center' as const }}>
        <p className="lp-display" style={{ fontSize: 'clamp(26px, 4vw, 36px)', fontWeight: 700, color: L.ink, marginBottom: 14, maxWidth: 520, margin: '0 auto 14px' }}>
          Stop running two half-businesses.
        </p>
        <p style={{ fontSize: 15.5, color: L.inkSoft, marginBottom: 28 }}>14 days free. No card needed to start.</p>
        <button onClick={() => navigate('/signup')} style={{ background: L.navy, color: 'white', border: 'none', borderRadius: 12, padding: '16px 32px', fontSize: 15.5, fontWeight: 700, cursor: 'pointer' }}>
          Start Selling With SalesPilot
        </button>
      </div>

      {/* Footer */}
      <div style={{ borderTop: `1px solid ${L.paperDeep}`, padding: '24px 20px', textAlign: 'center' as const }}>
        <p style={{ fontSize: 12.5, color: L.inkSoft }}>&copy; {new Date().getFullYear()} SalesPilot. Built for sellers, not spreadsheets.</p>
      </div>
    </div>
  );
}

// A real, public page any referrer can bookmark and check themselves, anytime - no login, no
// asking the owner, no just trusting what they're told. Reads the exact same numbers the owner
// sees in their own dashboard, straight from the database, live.
export function ReferralStatsPage() {
  const { code } = useParams<{ code: string }>();
  const [referrer, setReferrer] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!code) return;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'referrers', code));
        if (snap.exists()) {
          setReferrer(snap.data());
        } else {
          setNotFound(true);
        }
      } catch {
        setNotFound(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [code]);

  const link = typeof window !== 'undefined' ? `${window.location.origin}/?ref=${code}` : '';

  return (
    <div style={{ minHeight: '100vh', background: '#FBF6EE', fontFamily: 'Inter, sans-serif', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', padding: '48px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 32 }}>
        <AppLogo size={30} />
        <span style={{ fontSize: 17, fontWeight: 700, color: '#0F2A44' }}>SalesPilot</span>
      </div>

      {loading ? (
        <p style={{ fontSize: 14, color: '#5B6472' }}>Loading...</p>
      ) : notFound ? (
        <p style={{ fontSize: 14, color: '#5B6472' }}>We couldn't find a referral link with this code.</p>
      ) : (
        <div style={{ width: '100%', maxWidth: 420 }}>
          <p style={{ fontSize: 13, color: '#5B6472', textAlign: 'center' as const, marginBottom: 4 }}>Referral results for</p>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#0F2A44', textAlign: 'center' as const, marginBottom: 28 }}>{referrer?.name || code}</h1>

          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12, marginBottom: 24 }}>
            <div style={{ background: 'white', borderRadius: 16, padding: 20, boxShadow: '0 4px 16px rgba(15,42,68,0.06)' }}>
              <p style={{ fontSize: 12, color: '#5B6472', fontWeight: 600, marginBottom: 4 }}>People who signed up through your link</p>
              <p style={{ fontSize: 32, fontWeight: 800, color: '#0F2A44' }}>{referrer?.referredCount || 0}</p>
            </div>
            <div style={{ background: 'white', borderRadius: 16, padding: 20, boxShadow: '0 4px 16px rgba(15,42,68,0.06)' }}>
              <p style={{ fontSize: 12, color: '#5B6472', fontWeight: 600, marginBottom: 4 }}>Of those, became paying customers</p>
              <p style={{ fontSize: 32, fontWeight: 800, color: '#16A34A' }}>{referrer?.payingCount || 0}</p>
            </div>
            <div style={{ background: 'white', borderRadius: 16, padding: 20, boxShadow: '0 4px 16px rgba(15,42,68,0.06)' }}>
              <p style={{ fontSize: 12, color: '#5B6472', fontWeight: 600, marginBottom: 4 }}>Real revenue you helped bring in</p>
              <p style={{ fontSize: 32, fontWeight: 800, color: '#0F2A44' }}>{NAIRA}{(referrer?.revenue || 0).toLocaleString()}</p>
            </div>
          </div>

          <p style={{ fontSize: 11.5, color: '#5B6472', textAlign: 'center' as const, marginBottom: 24, lineHeight: 1.5 }}>
            These numbers are pulled directly from our records the moment you load this page,
            not something typed in by hand. Bookmark this page to check back anytime.
          </p>

          <div style={{ background: 'white', borderRadius: 12, padding: 14, textAlign: 'center' as const }}>
            <p style={{ fontSize: 11, color: '#5B6472', marginBottom: 6 }}>Your link</p>
            <p style={{ fontSize: 12.5, color: '#0F2A44', fontWeight: 600, wordBreak: 'break-all' as const }}>{link}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function OwnerDashboardScreen({ onBack }: { onBack: () => void }) {
  const [merchants, setMerchants] = useState<any[]>([]);
  const [referrers, setReferrers] = useState<any[]>([]);
  const [emailsToday, setEmailsToday] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedMerchant, setSelectedMerchant] = useState<any | null>(null);
  const [actionMsg, setActionMsg] = useState('');
  const [actionLoading, setActionLoading] = useState(false);
  const [newReferrerName, setNewReferrerName] = useState('');
  const [creatingReferrer, setCreatingReferrer] = useState(false);
  const [copiedCode, setCopiedCode] = useState('');

  const loadData = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, 'merchants'));
      const list = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
      setMerchants(list);
      const today = new Date().toISOString().slice(0, 10);
      const statsSnap = await getDoc(doc(db, 'platformStats', 'emailUsage'));
      setEmailsToday(statsSnap.exists() ? (statsSnap.data()[today] || 0) : 0);
      const refSnap = await getDocs(collection(db, 'referrers'));
      setReferrers(refSnap.docs.map(d => ({ code: d.id, ...d.data() })));
    } catch (err) {
      console.error('Could not load owner dashboard data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  // Turns a plain name like "Blessing - Instagram" into a real, working referral code and link
  // - lowercase, no spaces or symbols, a few random digits at the end so two similarly-named
  // referrers never collide with the same code by accident.
  const handleCreateReferrer = async () => {
    if (!newReferrerName.trim()) return;
    setCreatingReferrer(true);
    try {
      const base = newReferrerName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
      const code = `${base}${Math.floor(100 + Math.random() * 900)}`;
      await setDoc(doc(db, 'referrers', code), { name: newReferrerName.trim(), createdAt: new Date().toISOString() });
      setNewReferrerName('');
      loadData();
    } catch (err) {
      console.error('Could not create referrer:', err);
    } finally {
      setCreatingReferrer(false);
    }
  };

  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

  // For each referrer, real merchants are matched by the referredBy code saved on their
  // profile at the moment they signed up - this is the actual proof of who to pay, not a guess.
  // Reads the same stored counters the referrer's own public stats page reads - a single
  // source of truth, so the owner and the referrer are never looking at two different numbers.
  const referrerStats = referrers.map(r => ({
    ...r,
    referredCount: r.referredCount || 0,
    payingCount: r.payingCount || 0,
    revenue: r.revenue || 0,
  }));

  const totalMerchants = merchants.length;
  const newThisWeek = merchants.filter(m => m.trialStart && new Date(m.trialStart).getTime() > weekAgo).length;
  const newThisMonth = merchants.filter(m => m.trialStart && new Date(m.trialStart).getTime() > monthAgo).length;
  const payingMerchants = merchants.filter(m => m.subscriptionExpiresAt && new Date(m.subscriptionExpiresAt).getTime() > now);
  const trialMerchants = merchants.filter(m => !(m.subscriptionExpiresAt && new Date(m.subscriptionExpiresAt).getTime() > now));
  const starterCount = payingMerchants.filter(m => m.plan !== 'pro').length;
  const growthCount = payingMerchants.filter(m => m.plan === 'pro').length;

  const totalRevenue = merchants.reduce((sum, m) => {
    const history = m.subscriptionHistory || [];
    return sum + history.reduce((s: number, p: any) => s + (p.amount || 0), 0);
  }, 0);
  const monthRevenue = merchants.reduce((sum, m) => {
    const history = m.subscriptionHistory || [];
    return sum + history.filter((p: any) => p.paidAt && new Date(p.paidAt).getTime() > monthAgo).reduce((s: number, p: any) => s + (p.amount || 0), 0);
  }, 0);

  // Merges signups and payments from every merchant into one chronological feed - the closest
  // thing to a real-time pulse on the whole platform without digging through Firestore by hand.
  const activityFeed = (() => {
    const events: { type: string; label: string; time: number; sub: string }[] = [];
    merchants.forEach(m => {
      if (m.trialStart) {
        events.push({ type: 'signup', label: m.storeName || m.name || m.email || 'New merchant', time: new Date(m.trialStart).getTime(), sub: 'Started free trial' });
      }
      (m.subscriptionHistory || []).forEach((p: any) => {
        events.push({ type: 'payment', label: m.storeName || m.name || m.email || 'Merchant', time: new Date(p.paidAt).getTime(), sub: `Paid ${NAIRA}${(p.amount || 0).toLocaleString()} for ${p.planName || p.plan}` });
      });
    });
    return events.sort((a, b) => b.time - a.time).slice(0, 15);
  })();

  const filteredMerchants = merchants
    .filter(m => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return (m.storeName || '').toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q) || (m.email || '').toLowerCase().includes(q);
    })
    .sort((a, b) => new Date(b.trialStart || 0).getTime() - new Date(a.trialStart || 0).getTime());

  const emailPercent = Math.min((emailsToday / 100) * 100, 100);
  const emailColor = emailPercent >= 80 ? '#EF4444' : emailPercent >= 50 ? '#F59E0B' : C.green;

  const handleExtendTrial = async (merchant: any) => {
    setActionLoading(true);
    setActionMsg('');
    try {
      // Extending a trial just means pushing trialStart forward to today, giving a fresh
      // 14-day window using the exact same logic the app already uses everywhere else.
      await setDoc(doc(db, 'merchants', merchant.uid), { trialStart: new Date().toISOString() }, { merge: true });
      setActionMsg('Trial extended by 14 days.');
      loadData();
    } catch (err: any) {
      setActionMsg(`Could not extend trial: ${err?.code || err?.message || 'unknown error'}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleChangePlan = async (merchant: any, plan: 'basic' | 'pro', days: number) => {
    setActionLoading(true);
    setActionMsg('');
    try {
      const newExpiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      await setDoc(doc(db, 'merchants', merchant.uid), { plan, subscriptionExpiresAt: newExpiry }, { merge: true });
      setActionMsg(`Plan set to ${plan === 'pro' ? 'Growth' : 'Starter'} for ${days} days, no payment required.`);
      loadData();
    } catch (err: any) {
      setActionMsg(`Could not change plan: ${err?.code || err?.message || 'unknown error'}`);
    } finally {
      setActionLoading(false);
    }
  };

  if (selectedMerchant) {
    const isPaying = selectedMerchant.subscriptionExpiresAt && new Date(selectedMerchant.subscriptionExpiresAt).getTime() > now;
    return (
      <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Inter, sans-serif' }}>
        <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '20px 20px 28px', display: 'flex', alignItems: 'center', gap: 14 }}>
          <button onClick={() => { setSelectedMerchant(null); setActionMsg(''); }} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 10, width: 38, height: 38, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <ArrowLeft size={18} color="white" />
          </button>
          <h2 style={{ color: 'white', fontSize: 17, fontWeight: 700 }}>{selectedMerchant.storeName || selectedMerchant.name || 'Merchant'}</h2>
        </div>
        <div style={{ background: C.white, borderRadius: '24px 24px 0 0', marginTop: -16, padding: 20, paddingBottom: 100 }}>
          <div style={{ marginBottom: 20 }}>
            <p style={{ fontSize: 12, color: C.gray, marginBottom: 2 }}>Email</p>
            <p style={{ fontSize: 14, fontWeight: 600, color: C.dark, marginBottom: 12 }}>{selectedMerchant.email || '-'}</p>
            <p style={{ fontSize: 12, color: C.gray, marginBottom: 2 }}>Status</p>
            <p style={{ fontSize: 14, fontWeight: 600, color: isPaying ? C.green : C.orange, marginBottom: 12 }}>
              {isPaying ? `${selectedMerchant.plan === 'pro' ? 'Growth' : 'Starter'} active until ${new Date(selectedMerchant.subscriptionExpiresAt).toLocaleDateString()}` : 'On free trial / not paying'}
            </p>
            <p style={{ fontSize: 12, color: C.gray, marginBottom: 2 }}>Signed up</p>
            <p style={{ fontSize: 14, fontWeight: 600, color: C.dark }}>{selectedMerchant.trialStart ? new Date(selectedMerchant.trialStart).toLocaleDateString() : '-'}</p>
          </div>

          <div style={{ background: C.blueLight, borderRadius: 12, padding: 14, marginBottom: 20 }}>
            <p style={{ fontSize: 12.5, fontWeight: 700, color: C.blue, marginBottom: 4 }}>Free trial</p>
            <p style={{ fontSize: 12, color: C.dark, marginBottom: 10, lineHeight: 1.5 }}>Every new merchant already gets 2 free weeks automatically. Use this only if this specific merchant needs a bit more time before they decide.</p>
            <button disabled={actionLoading} onClick={() => handleExtendTrial(selectedMerchant)} style={{ width: '100%', background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: 12, fontSize: 13, fontWeight: 700, color: C.dark, cursor: 'pointer', textAlign: 'left' as const }}>
              Give this merchant 2 more free weeks
            </button>
          </div>

          <div style={{ background: C.greenLight, borderRadius: 12, padding: 14, marginBottom: 20 }}>
            <p style={{ fontSize: 12.5, fontWeight: 700, color: C.green, marginBottom: 4 }}>Manual free access</p>
            <p style={{ fontSize: 12, color: C.dark, marginBottom: 10, lineHeight: 1.5 }}>Separate from the trial above. This unlocks a full paid plan for this merchant without them actually paying, for one month, for special cases only (an apology, a favor, a test account).</p>
            <button disabled={actionLoading} onClick={() => handleChangePlan(selectedMerchant, 'basic', 30)} style={{ width: '100%', background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: 12, fontSize: 13, fontWeight: 700, color: C.dark, cursor: 'pointer', marginBottom: 8, textAlign: 'left' as const }}>
              Unlock Starter free, for 1 month
            </button>
            <button disabled={actionLoading} onClick={() => handleChangePlan(selectedMerchant, 'pro', 30)} style={{ width: '100%', background: C.white, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: 12, fontSize: 13, fontWeight: 700, color: C.dark, cursor: 'pointer', textAlign: 'left' as const }}>
              Unlock Growth free, for 1 month
            </button>
          </div>
          {actionMsg && <p style={{ fontSize: 12.5, color: C.green, marginTop: -10, marginBottom: 10, fontWeight: 600 }}>{actionMsg}</p>}
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: 'Inter, sans-serif', paddingBottom: 40 }}>
      <div style={{ background: `linear-gradient(135deg, ${C.navy}, ${C.navyLight})`, padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 9, width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <ArrowLeft size={16} color="white" />
          </button>
          <h1 style={{ color: 'white', fontSize: 18, fontWeight: 700 }}>Owner Dashboard</h1>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center' as const }}>
          <p style={{ fontSize: 13, color: C.gray }}>Loading...</p>
        </div>
      ) : (
        <div style={{ padding: 20 }}>
          {/* Merchant Overview */}
          <p style={{ fontSize: 12, fontWeight: 800, color: C.gray, textTransform: 'uppercase' as const, letterSpacing: 0.6, marginBottom: 10 }}>Merchants</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 8 }}>
            <div style={{ background: C.white, borderRadius: 14, padding: 14, boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
              <p style={{ fontSize: 11, color: C.gray, fontWeight: 700 }}>Total</p>
              <p style={{ fontSize: 22, fontWeight: 800, color: C.dark }}>{totalMerchants}</p>
            </div>
            <div style={{ background: C.white, borderRadius: 14, padding: 14, boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
              <p style={{ fontSize: 11, color: C.gray, fontWeight: 700 }}>New This Week</p>
              <p style={{ fontSize: 22, fontWeight: 800, color: C.dark }}>{newThisWeek}</p>
            </div>
            <div style={{ background: C.greenLight, borderRadius: 14, padding: 14 }}>
              <p style={{ fontSize: 11, color: C.green, fontWeight: 700 }}>Paying</p>
              <p style={{ fontSize: 22, fontWeight: 800, color: C.dark }}>{payingMerchants.length}</p>
            </div>
            <div style={{ background: C.orangeLight, borderRadius: 14, padding: 14 }}>
              <p style={{ fontSize: 11, color: C.orange, fontWeight: 700 }}>On Trial</p>
              <p style={{ fontSize: 22, fontWeight: 800, color: C.dark }}>{trialMerchants.length}</p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
            <div style={{ flex: 1, background: C.blueLight, borderRadius: 12, padding: 12, textAlign: 'center' as const }}>
              <p style={{ fontSize: 11, color: C.blue, fontWeight: 700 }}>Starter</p>
              <p style={{ fontSize: 17, fontWeight: 800, color: C.dark }}>{starterCount}</p>
            </div>
            <div style={{ flex: 1, background: C.purpleLight, borderRadius: 12, padding: 12, textAlign: 'center' as const }}>
              <p style={{ fontSize: 11, color: C.purple, fontWeight: 700 }}>Growth</p>
              <p style={{ fontSize: 17, fontWeight: 800, color: C.dark }}>{growthCount}</p>
            </div>
          </div>

          {/* Revenue */}
          <p style={{ fontSize: 12, fontWeight: 800, color: C.gray, textTransform: 'uppercase' as const, letterSpacing: 0.6, marginBottom: 10 }}>Revenue</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 24 }}>
            <div style={{ background: C.white, borderRadius: 14, padding: 14, boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
              <p style={{ fontSize: 11, color: C.gray, fontWeight: 700 }}>This Month</p>
              <p style={{ fontSize: 18, fontWeight: 800, color: C.dark }}>{NAIRA}{monthRevenue.toLocaleString()}</p>
            </div>
            <div style={{ background: C.white, borderRadius: 14, padding: 14, boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
              <p style={{ fontSize: 11, color: C.gray, fontWeight: 700 }}>All Time</p>
              <p style={{ fontSize: 18, fontWeight: 800, color: C.dark }}>{NAIRA}{totalRevenue.toLocaleString()}</p>
            </div>
          </div>

          {/* Email usage - the "silent failure" warning */}
          <p style={{ fontSize: 12, fontWeight: 800, color: C.gray, textTransform: 'uppercase' as const, letterSpacing: 0.6, marginBottom: 10 }}>Email Usage Today</p>
          <div style={{ background: C.white, borderRadius: 14, padding: 16, marginBottom: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: C.dark }}>{emailsToday} of 100 sent</p>
              <p style={{ fontSize: 12, fontWeight: 700, color: emailColor }}>{emailPercent >= 80 ? 'Near limit' : emailPercent >= 50 ? 'Watch this' : 'Healthy'}</p>
            </div>
            <div style={{ height: 8, background: C.bg, borderRadius: 20, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${emailPercent}%`, background: emailColor, borderRadius: 20 }} />
            </div>
            {emailPercent >= 80 && (
              <p style={{ fontSize: 11.5, color: '#EF4444', marginTop: 10, lineHeight: 1.5 }}>Close to Resend's free daily limit - real signup and order emails could start failing. Consider upgrading Resend's plan.</p>
            )}
          </div>

          {/* Activity feed */}
          <p style={{ fontSize: 12, fontWeight: 800, color: C.gray, textTransform: 'uppercase' as const, letterSpacing: 0.6, marginBottom: 10 }}>Recent Activity</p>
          <div style={{ background: C.white, borderRadius: 14, padding: 6, marginBottom: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
            {activityFeed.length === 0 ? (
              <p style={{ fontSize: 13, color: C.gray, textAlign: 'center' as const, padding: 20 }}>No activity yet.</p>
            ) : activityFeed.map((e, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 10px', borderBottom: i < activityFeed.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: e.type === 'payment' ? C.greenLight : C.blueLight, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {e.type === 'payment' ? <Wallet size={14} color={C.green} /> : <Users size={14} color={C.blue} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 13, fontWeight: 700, color: C.dark }}>{e.label}</p>
                  <p style={{ fontSize: 11.5, color: C.gray }}>{e.sub}</p>
                </div>
                <p style={{ fontSize: 10.5, color: C.gray, flexShrink: 0 }}>{new Date(e.time).toLocaleDateString()}</p>
              </div>
            ))}
          </div>

          {/* Referrals */}
          <p style={{ fontSize: 12, fontWeight: 800, color: C.gray, textTransform: 'uppercase' as const, letterSpacing: 0.6, marginBottom: 10 }}>Referral Links</p>
          <div style={{ background: C.white, borderRadius: 14, padding: 16, marginBottom: 14, boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
            <p style={{ fontSize: 12, color: C.gray, marginBottom: 10 }}>Create a trackable link for a creator or promoter - you'll see exactly who they bring in, and who actually becomes a paying merchant.</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={newReferrerName}
                onChange={e => setNewReferrerName(e.target.value)}
                placeholder="e.g. Blessing - Instagram"
                style={{ flex: 1, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${C.border}`, fontSize: 13, outline: 'none' }}
              />
              <button disabled={creatingReferrer} onClick={handleCreateReferrer} style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 10, padding: '0 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: creatingReferrer ? 0.7 : 1 }}>
                {creatingReferrer ? '...' : 'Create'}
              </button>
            </div>
          </div>

          {referrerStats.length > 0 && (
            <div style={{ background: C.white, borderRadius: 14, padding: 6, marginBottom: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
              {referrerStats.map((r, i) => {
                const link = `${window.location.origin}/?ref=${r.code}`;
                const statsLink = `${window.location.origin}/ref/${r.code}`;
                return (
                  <div key={r.code} style={{ padding: '12px 10px', borderBottom: i < referrerStats.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                      <p style={{ fontSize: 13.5, fontWeight: 700, color: C.dark }}>{r.name}</p>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => { copyToClipboard(link); setCopiedCode(r.code); setTimeout(() => setCopiedCode(''), 2000); }} style={{ background: C.bg, border: 'none', borderRadius: 8, padding: '5px 10px', fontSize: 11, fontWeight: 700, color: C.navy, cursor: 'pointer', flexShrink: 0 }}>
                          {copiedCode === r.code ? 'Copied!' : 'Referral Link'}
                        </button>
                        <button onClick={() => { copyToClipboard(statsLink); setCopiedCode(`stats-${r.code}`); setTimeout(() => setCopiedCode(''), 2000); }} style={{ background: C.greenLight, border: 'none', borderRadius: 8, padding: '5px 10px', fontSize: 11, fontWeight: 700, color: C.green, cursor: 'pointer', flexShrink: 0 }}>
                          {copiedCode === `stats-${r.code}` ? 'Copied!' : 'Their Stats Link'}
                        </button>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 16 }}>
                      <div>
                        <p style={{ fontSize: 10.5, color: C.gray }}>Signed up</p>
                        <p style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>{r.referredCount}</p>
                      </div>
                      <div>
                        <p style={{ fontSize: 10.5, color: C.gray }}>Paying</p>
                        <p style={{ fontSize: 14, fontWeight: 700, color: C.green }}>{r.payingCount}</p>
                      </div>
                      <div>
                        <p style={{ fontSize: 10.5, color: C.gray }}>Revenue Brought</p>
                        <p style={{ fontSize: 14, fontWeight: 700, color: C.dark }}>{NAIRA}{r.revenue.toLocaleString()}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Merchant list */}
          <p style={{ fontSize: 12, fontWeight: 800, color: C.gray, textTransform: 'uppercase' as const, letterSpacing: 0.6, marginBottom: 10 }}>All Merchants</p>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or email"
            style={{ width: '100%', padding: '11px 14px', borderRadius: 12, border: `1.5px solid ${C.border}`, fontSize: 13.5, outline: 'none', marginBottom: 12, boxSizing: 'border-box' as const }}
          />
          <div style={{ background: C.white, borderRadius: 14, padding: 6, boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
            {filteredMerchants.length === 0 ? (
              <p style={{ fontSize: 13, color: C.gray, textAlign: 'center' as const, padding: 20 }}>No merchants found.</p>
            ) : filteredMerchants.map((m, i) => {
              const paying = m.subscriptionExpiresAt && new Date(m.subscriptionExpiresAt).getTime() > now;
              return (
                <div key={m.uid} onClick={() => setSelectedMerchant(m)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 10px', borderBottom: i < filteredMerchants.length - 1 ? `1px solid ${C.border}` : 'none', cursor: 'pointer' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 13.5, fontWeight: 700, color: C.dark }}>{m.storeName || m.name || 'Unnamed'}</p>
                    <p style={{ fontSize: 11.5, color: C.gray }}>{m.email || '-'}</p>
                  </div>
                  <span style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: paying ? C.greenLight : C.orangeLight, color: paying ? C.green : C.orange, flexShrink: 0 }}>
                    {paying ? (m.plan === 'pro' ? 'Growth' : 'Starter') : 'Trial'}
                  </span>
                  <ChevronRight size={16} color={C.gray} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function AppRoutes() {
  const { user, authReady } = useAuth();
  if (!authReady) {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 36, height: 36, border: `3px solid ${C.border}`, borderTopColor: C.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }
  return (
    <Routes>
      <Route path="/" element={user ? <Navigate to={user.onboardingComplete ? '/dashboard' : '/onboarding'} /> : <LandingPage />} />
      <Route path="/ref/:code" element={<ReferralStatsPage />} />
      <Route path="/signup" element={user ? <Navigate to={user.onboardingComplete ? '/dashboard' : '/onboarding'} /> : <Signup />} />
      <Route path="/login" element={user ? <Navigate to={user.onboardingComplete ? '/dashboard' : '/onboarding'} /> : <Login />} />
      <Route path="/join-staff/:merchantUid/:staffId/:code" element={<StaffJoinScreen />} />
      <Route path="/onboarding" element={user ? <Onboarding /> : <Navigate to="/signup" />} />
      <Route path="/dashboard" element={user ? (user.onboardingComplete ? <Dashboard /> : <Navigate to="/onboarding" />) : <Navigate to="/signup" />} />
      <Route path="/:slug/checkout" element={<CheckoutScreen />} />
      <Route path="/:slug/track" element={<TrackOrderScreen />} />
      <Route path="/:slug/order/:reference/:token" element={<OrderLinkScreen />} />
      <Route path="/:slug/product/:productId" element={<ProductDetailScreen />} />
      <Route path="/:slug" element={<StorefrontScreen />} />
    </Routes>
  );
}

// A splash shown once when the app is first opened - shows for at least 5 seconds, but also
// waits for the real app underneath to actually be ready (signed in or not, which screen to
// show, etc.) before ever fading out. This matters: without waiting for real readiness, the
// splash could disappear before Firebase has finished checking who's signed in, leaving a
// second, jarring loading spinner right after the splash - exactly the "double loading" feeling
// this is built to avoid. Once the splash fades, the real app is already the very next thing
// shown, nothing else loads after it.
function SplashScreen() {
  const [phase, setPhase] = useState<'logo' | 'combined'>('logo');
  useEffect(() => {
    const t = setTimeout(() => setPhase('combined'), 1100);
    return () => clearTimeout(t);
  }, []);

  return (
    <div style={{ position: 'fixed' as const, inset: 0, background: `linear-gradient(160deg, ${C.navy} 0%, ${C.navyLight} 60%, #0d1f33 100%)`, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', zIndex: 999 }}>
      <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center' }}>
        <div style={{ animation: 'sp-logo-in 0.8s cubic-bezier(0.34, 1.56, 0.64, 1) forwards' }}>
          <AppLogo size={92} />
        </div>
        <div style={{
          opacity: phase === 'combined' ? 1 : 0,
          transition: 'opacity 0.5s ease',
          marginTop: 18, minHeight: 50, display: 'flex', flexDirection: 'column' as const, alignItems: 'center',
        }}>
          <span style={{ fontSize: 28, fontWeight: 800, color: 'white', letterSpacing: 0.4 }}>SalesPilot</span>
          <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.65)', marginTop: 4, letterSpacing: 0.3 }}>Your business, in your pocket</span>
        </div>
      </div>
      <style>{`@keyframes sp-logo-in { from { opacity: 0; transform: scale(0.6); } to { opacity: 1; transform: scale(1); } }`}</style>
    </div>
  );
}

// Holds the splash on screen for a minimum of 5 seconds AND until Firebase auth has actually
// finished resolving, whichever takes longer - so the splash is always covering real loading
// time, never just decoration sitting in front of more loading underneath it. Uses
// sessionStorage rather than localStorage on purpose: sessionStorage naturally survives normal
// backgrounding and moving between screens inside the app, but clears once the app is actually
// closed or swiped away from recent apps - so the splash reappears on a real fresh open, but
// never interrupts someone just switching to another screen or briefly checking something else.
// Catches any crash anywhere in the app and shows a real, readable message instead of a silent
// blank white screen - without this, any unexpected error deep in a screen leaves the whole app
// looking dead with zero explanation, to the merchant or to anyone trying to help them fix it.
class ErrorBoundary extends Component<{ children: any }, { error: Error | null }> {
  constructor(props: { children: any }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' as const, fontFamily: 'Inter, sans-serif' }}>
          <AlertTriangle size={32} color="#EF4444" style={{ marginBottom: 14 }} />
          <p style={{ fontSize: 15, fontWeight: 700, color: C.dark, marginBottom: 8 }}>Something went wrong</p>
          <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 20, maxWidth: 320, wordBreak: 'break-word' as const }}>{this.state.error.message || String(this.state.error)}</p>
          <button onClick={() => window.location.reload()} style={{ background: C.navy, color: 'white', border: 'none', borderRadius: 12, padding: '12px 24px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Instant hand-off from splash to the real app once it's time - deliberately NOT using a fade
// transition or unmount delay here, since that kind of opacity-transition-then-remove pattern is
// exactly the shape of bug that can leave some mobile browsers stuck showing a stale, blank frame
// until the user forces a repaint (e.g. tapping the address bar). A hard, immediate swap avoids
// that whole category of problem entirely.
function SplashGate() {
  const { authReady } = useAuth();
  const [minTimeElapsed, setMinTimeElapsed] = useState(false);
  const [forceDone, setForceDone] = useState(false);
  const [showSplash, setShowSplash] = useState(() => {
    try { return !sessionStorage.getItem('sp_splash_seen'); } catch { return true; }
  });

  useEffect(() => {
    if (!showSplash) return;
    const t = setTimeout(() => setMinTimeElapsed(true), 5000);
    // Safety net: no matter what happens with auth, never leave the splash on screen forever -
    // force it to finish after 8 seconds total either way.
    const safety = setTimeout(() => setForceDone(true), 8000);
    return () => { clearTimeout(t); clearTimeout(safety); };
  }, [showSplash]);

  useEffect(() => {
    if ((minTimeElapsed && authReady) || forceDone) {
      try { sessionStorage.setItem('sp_splash_seen', '1'); } catch {}
      setShowSplash(false);
    }
  }, [minTimeElapsed, authReady, forceDone]);

  if (showSplash) {
    return <SplashScreen />;
  }
  return <AppRoutes />;
}

export default function App() {
  useEffect(() => { captureReferralCode(); }, []);
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <div className="app-shell">
            <SplashGate />
          </div>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}