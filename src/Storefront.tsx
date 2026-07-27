import { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { db } from './firebase';
import { collection, query, where, limit, getDocs, onSnapshot, doc, setDoc, getDoc, increment, addDoc } from 'firebase/firestore';
import {
  Search, ShoppingBag, ArrowLeft, ArrowRight, ChevronDown, ChevronRight, ChevronLeft, CheckCircle2, MessageCircle,
  Menu, Heart, ShoppingCart, Truck, ShieldCheck, RotateCcw, Sparkles, SlidersHorizontal, Zap, Star, X,
  Shirt, Footprints, Watch, Sofa, Smartphone, Baby, HeartPulse, Tag, Plus, Minus, Phone, MapPin, Lock, Package, Clock, AlertCircle,
} from 'lucide-react';
import { NAIRA, THEME_NICHES, ProductIcon, isValidCSSColor, isColorOptionGroup, getTieredPrice, NIGERIAN_STATES, PAYSTACK_PUBLIC_KEY, getCourierCustomerPrice, getPlatformOrderFee, getOptimizedImageUrl, PLATFORM_LOGO_URL } from './shared';
import type { StoreTheme, Product, Review, Order, OrderItem, Bundle, Courier, CheckoutField } from './shared';

type MerchantInfo = {
  uid: string;
  storeName?: string;
  storeDescription?: string;
  coverImageUrl?: string;
  logoUrl?: string;
  themeId?: string;
  contactWhatsapp?: string;
  contactEmail?: string;
  announcementBanner?: string;
  storeAddress?: string;
  facebookPixelId?: string;
  googleAnalyticsId?: string;
  customTrackingCode?: string;
  saleEndsAt?: string;
  saleLabel?: string;
  cartTimerMinutes?: number;
  shippingRates?: { [state: string]: number };
  defaultShippingFee?: number;
  couriers?: Courier[];
  checkoutFields?: CheckoutField[];
  feePaidByCustomer?: boolean;
  paystackSubaccountCode?: string;
  termsAndConditions?: string;
  termsRequired?: boolean;
  plan?: string;
  trialStart?: string;
  subscriptionExpiresAt?: string;
};

// Mirrors isProAccess() in App.tsx - kept as a separate copy here since Storefront.tsx and
// App.tsx don't share runtime code, only types (shared.tsx). A merchant has "Pro access" if
// they're still within their 14-day free trial, OR if they've actually paid for Pro and that
// payment hasn't expired yet.
function isProAccess(merchant: MerchantInfo | null): boolean {
  if (!merchant) return false;
  if (merchant.trialStart) {
    const elapsedDays = Math.floor((Date.now() - new Date(merchant.trialStart).getTime()) / (1000 * 60 * 60 * 24));
    if (elapsedDays < 14) return true;
  }
  if (merchant.plan === 'pro' && merchant.subscriptionExpiresAt) {
    return new Date(merchant.subscriptionExpiresAt).getTime() > Date.now();
  }
  return false;
}

// Mirrors pushNotification() in App.tsx - writes a real notification the merchant will see
// via the bell icon on their dashboard. Silently logs failure rather than throwing, so a
// notification hiccup never blocks whatever real customer-facing action triggered it.
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

const CATEGORY_ICONS: { [key: string]: any } = {
  'Fashion & Clothing': Shirt,
  'Shoes & Footwear': Footprints,
  'Bags & Accessories': ShoppingBag,
  'Jewelry & Watches': Watch,
  'Beauty & Skincare': Sparkles,
  'Electronics & Gadgets': Smartphone,
  'Home & Furniture': Sofa,
  'Food & Groceries': ShoppingBag,
  'Baby & Kids': Baby,
  'Health & Wellness': HeartPulse,
  'Other': Tag,
};

function getTheme(themeId?: string): StoreTheme {
  const found = THEME_NICHES.flatMap(n => n.themes).find(t => t.id === themeId);
  return found || THEME_NICHES[0].themes[0];
}

let fontLoaded = false;
function usePremiumFont() {
  useEffect(() => {
    if (fontLoaded) return;
    fontLoaded = true;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700;800&display=swap';
    document.head.appendChild(link);
  }, []);
}

function useMerchantBySlug(slug: string | undefined) {
  const [merchantUid, setMerchantUid] = useState<string | null>(() => {
    if (!slug) return null;
    try { return sessionStorage.getItem(`sp_slug_${slug}`); } catch { return null; }
  });
  const [merchant, setMerchant] = useState<MerchantInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!slug) return;
    if (merchantUid) return; // already cached from a previous lookup this session
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    (async () => {
      try {
        const q = query(collection(db, 'merchants'), where('storeSlug', '==', slug), limit(1));
        const snap = await getDocs(q);
        if (cancelled) return;
        if (snap.empty) { setNotFound(true); setLoading(false); }
        else {
          const uid = snap.docs[0].id;
          try { sessionStorage.setItem(`sp_slug_${slug}`, uid); } catch {}
          setMerchantUid(uid);
        }
      } catch (err) {
        if (!cancelled) { setNotFound(true); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [slug, merchantUid]);

  useEffect(() => {
    if (!merchantUid) return;
    const unsub = onSnapshot(doc(db, 'merchants', merchantUid), (snap) => {
      if (snap.exists()) { setMerchant({ uid: merchantUid, ...(snap.data() as any) }); setLoading(false); }
      else { setNotFound(true); setLoading(false); }
    }, () => { setNotFound(true); setLoading(false); });
    return unsub;
  }, [merchantUid]);

  return { merchant, loading, notFound };
}

// Injects Facebook Pixel, Google Analytics, and any custom tracking code the merchant has
// added, once per page session. Safe to call from multiple screens - only loads each once.
function useTrackingScripts(merchant: MerchantInfo | null) {
  useEffect(() => {
    if (!merchant) return;
    const w = window as any;

    if (merchant.facebookPixelId && !w._spFbPixelLoaded) {
      w._spFbPixelLoaded = true;
      const s = document.createElement('script');
      s.innerHTML = `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${merchant.facebookPixelId}');fbq('track','PageView');`;
      document.head.appendChild(s);
    }

    if (merchant.googleAnalyticsId && !w._spGaLoaded) {
      w._spGaLoaded = true;
      const s1 = document.createElement('script');
      s1.src = `https://www.googletagmanager.com/gtag/js?id=${merchant.googleAnalyticsId}`;
      s1.async = true;
      document.head.appendChild(s1);
      const s2 = document.createElement('script');
      s2.innerHTML = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${merchant.googleAnalyticsId}');`;
      document.head.appendChild(s2);
    }

    if (merchant.customTrackingCode && !w._spCustomTrackingLoaded) {
      w._spCustomTrackingLoaded = true;
      const container = document.createElement('div');
      container.innerHTML = merchant.customTrackingCode;
      // innerHTML-injected <script> tags don't execute automatically - re-create them so they do
      Array.from(container.querySelectorAll('script')).forEach(oldScript => {
        const newScript = document.createElement('script');
        Array.from(oldScript.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
        newScript.innerHTML = oldScript.innerHTML;
        document.head.appendChild(newScript);
      });
    }
  }, [merchant?.facebookPixelId, merchant?.googleAnalyticsId, merchant?.customTrackingCode]);
}

// Fires a standard ecommerce event to whichever tracking tools the merchant has connected.
function trackStoreEvent(eventName: string, params?: { value?: number; currency?: string; content_name?: string }) {
  const w = window as any;
  if (w.fbq) w.fbq('track', eventName, params);
  if (w.gtag) w.gtag('event', eventName.toLowerCase(), params);
}

// Works out which marketing channel actually brought this visitor to the store, so the
// merchant can see real numbers for WhatsApp vs Instagram vs Twitter etc. (matches what Bumpa's
// own Daily Report shows). Checks for an explicit ?ref= or ?src= link tag first (for merchants
// sharing a trackable bio link), then falls back to reading the browser's own referrer.
function detectTrafficSource(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    const explicit = (params.get('ref') || params.get('src') || '').toLowerCase();
    if (explicit) {
      if (explicit.includes('whatsapp') || explicit === 'wa') return 'WhatsApp';
      if (explicit.includes('instagram') || explicit === 'ig') return 'Instagram';
      if (explicit.includes('twitter') || explicit === 'x') return 'Twitter';
      if (explicit.includes('jiji')) return 'Jiji';
      if (explicit.includes('jumia')) return 'Jumia';
      if (explicit.includes('facebook') || explicit === 'fb') return 'Facebook';
      return explicit.charAt(0).toUpperCase() + explicit.slice(1);
    }
    const ref = document.referrer.toLowerCase();
    if (!ref) return 'Direct';
    if (ref.includes('whatsapp')) return 'WhatsApp';
    if (ref.includes('instagram')) return 'Instagram';
    if (ref.includes('twitter') || ref.includes('x.com')) return 'Twitter';
    if (ref.includes('jiji')) return 'Jiji';
    if (ref.includes('jumia')) return 'Jumia';
    if (ref.includes('facebook')) return 'Facebook';
    if (ref.includes('google')) return 'Google';
    return 'Other';
  } catch {
    return 'Direct';
  }
}

// Remembers which channel first brought this visitor in for the rest of their session (so
// clicking around the store afterward doesn't overwrite the original source), and logs one
// website visit per merchant per day - a lightweight daily counter, not a per-page-view log,
// to keep Firestore writes cheap.
function useTrafficTracking(merchantUid: string | undefined, slug: string | undefined) {
  useEffect(() => {
    if (!slug) return;
    try {
      const key = `sp_source_${slug}`;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, detectTrafficSource());
      }
    } catch {}
  }, [slug]);

  useEffect(() => {
    if (!merchantUid || !slug) return;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const loggedKey = `sp_visit_logged_${slug}_${today}`;
      if (sessionStorage.getItem(loggedKey)) return;
      sessionStorage.setItem(loggedKey, '1');
      setDoc(doc(db, 'merchants', merchantUid, 'analytics', today), { visits: increment(1) }, { merge: true }).catch(() => {});
    } catch {}
  }, [merchantUid, slug]);
}

// --- Session-only cart & wishlist (no backend yet; resets when the tab closes) ---
type CartLine = { productId: string; name: string; price: number; quantity: number; options?: { [k: string]: string }; minOrderQty?: number; maxOrderQty?: number; bundleName?: string; priceTiers?: { minQty: number; price: number }[] };

function storeKey(kind: string, slug: string) { return `sp_${kind}_${slug}`; }
function readList<T>(kind: string, slug: string): T[] {
  try { return JSON.parse(sessionStorage.getItem(storeKey(kind, slug)) || '[]'); } catch { return []; }
}
function writeList(kind: string, slug: string, items: any[]) {
  sessionStorage.setItem(storeKey(kind, slug), JSON.stringify(items));
  window.dispatchEvent(new Event(`sp-${kind}-updated`));
}
function addToCart(slug: string, product: Product, quantity: number, options?: { [k: string]: string }) {
  const cart = readList<CartLine>('cart', slug);
  const wasEmpty = cart.length === 0;
  const optKey = JSON.stringify(options || {});
  const idx = cart.findIndex(c => c.productId === product.id && JSON.stringify(c.options || {}) === optKey);
  if (idx >= 0) cart[idx].quantity += quantity;
  else cart.push({ productId: product.id, name: product.name, price: product.salePrice || product.price, quantity, options, minOrderQty: product.minOrderQty, maxOrderQty: product.maxOrderQty, priceTiers: product.priceTiers });
  writeList('cart', slug, cart);
  if (wasEmpty) {
    try { sessionStorage.setItem(`sp_cart_started_${slug}`, Date.now().toString()); } catch {}
  }
}
// Adds every product in a bundle to the cart as its own line item, with prices scaled down
// proportionally so they add up exactly to the bundle's combined price. This keeps stock
// deduction, MOQ/MaxOQ enforcement, and order itemization all working normally - a bundle
// is really just a fast way to add several real products to cart at a special combined price.
function addBundleToCart(slug: string, bundle: Bundle, bundleProducts: Product[]) {
  const cart = readList<CartLine>('cart', slug);
  const wasEmpty = cart.length === 0;
  const originalTotal = bundleProducts.reduce((sum, p) => sum + (p.salePrice || p.price), 0);
  let allocated = 0;
  bundleProducts.forEach((p, i) => {
    const isLast = i === bundleProducts.length - 1;
    const fullPrice = p.salePrice || p.price;
    const share = isLast ? bundle.bundlePrice - allocated : Math.round((fullPrice / originalTotal) * bundle.bundlePrice);
    allocated += share;
    cart.push({ productId: p.id, name: p.name, price: share, quantity: 1, minOrderQty: p.minOrderQty, maxOrderQty: p.maxOrderQty, bundleName: bundle.name });
  });
  writeList('cart', slug, cart);
  if (wasEmpty) {
    try { sessionStorage.setItem(`sp_cart_started_${slug}`, Date.now().toString()); } catch {}
  }
}
function useListCount(kind: string, slug: string | undefined, sumQty?: boolean) {
  const [count, setCount] = useState(() => {
    if (!slug) return 0;
    const list = readList<any>(kind, slug);
    return sumQty ? list.reduce((s: number, i: any) => s + (i.quantity || 1), 0) : list.length;
  });
  useEffect(() => {
    if (!slug) return;
    const handler = () => {
      const list = readList<any>(kind, slug);
      setCount(sumQty ? list.reduce((s: number, i: any) => s + (i.quantity || 1), 0) : list.length);
    };
    handler();
    window.addEventListener(`sp-${kind}-updated`, handler);
    return () => window.removeEventListener(`sp-${kind}-updated`, handler);
  }, [slug, kind, sumQty]);
  return count;
}
function toggleWishlistItem(slug: string, productId: string) {
  const list = readList<string>('wishlist', slug);
  const idx = list.indexOf(productId);
  if (idx >= 0) list.splice(idx, 1); else list.push(productId);
  writeList('wishlist', slug, list);
}
function useWishlist(slug: string | undefined) {
  const [items, setItems] = useState<string[]>(() => slug ? readList<string>('wishlist', slug) : []);
  useEffect(() => {
    if (!slug) return;
    const handler = () => setItems(readList<string>('wishlist', slug));
    handler();
    window.addEventListener('sp-wishlist-updated', handler);
    return () => window.removeEventListener('sp-wishlist-updated', handler);
  }, [slug]);
  return items;
}

function useCart(slug: string | undefined) {
  const [items, setItems] = useState<CartLine[]>(() => slug ? readList<CartLine>('cart', slug) : []);
  useEffect(() => {
    if (!slug) return;
    const handler = () => setItems(readList<CartLine>('cart', slug));
    handler();
    window.addEventListener('sp-cart-updated', handler);
    return () => window.removeEventListener('sp-cart-updated', handler);
  }, [slug]);
  return items;
}
function useCartTimer(cartTimerMinutes: number | undefined, slug: string | undefined, cartLength: number) {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [justExpired, setJustExpired] = useState(false);

  useEffect(() => {
    if (!cartTimerMinutes || !slug || cartLength === 0) { setSecondsLeft(null); return; }
    let started: number;
    try {
      const stamp = sessionStorage.getItem(`sp_cart_started_${slug}`);
      if (!stamp) { setSecondsLeft(null); return; }
      started = Number(stamp);
    } catch { setSecondsLeft(null); return; }
    const expiresAt = started + cartTimerMinutes * 60000;
    const tick = () => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) {
        clearCart(slug);
        setJustExpired(true);
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [cartTimerMinutes, slug, cartLength]);

  return { secondsLeft, justExpired };
}
function updateCartQuantity(slug: string, index: number, quantity: number) {
  const cart = readList<CartLine>('cart', slug);
  if (quantity <= 0) { cart.splice(index, 1); }
  else if (cart[index]) { cart[index].quantity = quantity; }
  writeList('cart', slug, cart);
  if (cart.length === 0) { try { sessionStorage.removeItem(`sp_cart_started_${slug}`); } catch {} }
}
function removeFromCart(slug: string, index: number) {
  const cart = readList<CartLine>('cart', slug);
  cart.splice(index, 1);
  writeList('cart', slug, cart);
  if (cart.length === 0) { try { sessionStorage.removeItem(`sp_cart_started_${slug}`); } catch {} }
}
function clearCart(slug: string) {
  writeList('cart', slug, []);
  try { sessionStorage.removeItem(`sp_cart_started_${slug}`); } catch {}
}

// Mirrors decrementProductStock() in App.tsx - kept as a separate copy here since
// Storefront.tsx and App.tsx don't share runtime code, only types (shared.tsx).
async function decrementStockAfterOrder(merchantUid: string, items: OrderItem[]) {
  for (const item of items) {
    if (!item.productId) continue;
    try {
      const productRef = doc(db, 'merchants', merchantUid, 'products', item.productId);
      const snap = await getDocs(query(collection(db, 'merchants', merchantUid, 'products'), where('__name__', '==', item.productId)));
      if (snap.empty) continue;
      const data: any = snap.docs[0].data();
      if (typeof data.quantity !== 'number') continue;
      const newQuantity = Math.max(0, data.quantity - item.quantity);
      const newStatus = newQuantity === 0 ? 'Out of stock' : newQuantity <= 5 ? 'Low stock' : 'In stock';
      await setDoc(productRef, { quantity: newQuantity, status: newStatus }, { merge: true });
      if (newStatus !== data.status && (newStatus === 'Low stock' || newStatus === 'Out of stock')) {
        pushNotification(merchantUid, `${data.name || 'A product'} is now ${newStatus.toLowerCase()}`, newStatus === 'Out of stock' ? 'stock-out' : 'stock-low');
      }
    } catch (err) {
      console.error('Could not update stock for', item.productId, err);
    }
  }
}

// Sends an email via the Vercel backend. Silently logs failure rather than throwing, so an
// email hiccup never blocks or breaks the actual order/checkout flow the customer is doing.
async function sendStoreEmail(to: string, subject: string, html: string) {
  try {
    await fetch('https://sales-pilot-payment.vercel.app/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, html }),
    });
  } catch (err) {
    console.error('Could not send email:', err);
  }
}

function buildOrderConfirmationEmail(order: Order, storeName: string): string {
  const itemRows = order.items.map(it =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;">${it.name} x${it.quantity}</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">${NAIRA}${(it.price * it.quantity).toLocaleString()}</td></tr>`
  ).join('');
  return `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#111827;">
      <h2 style="margin-bottom:4px;">Thanks for your order!</h2>
      <p style="color:#6B7280;margin-top:0;">${storeName} - Ref: ${order.reference}</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">${itemRows}</table>
      ${order.shippingFee > 0 ? `<p style="font-size:14px;color:#374151;">Delivery to ${order.deliveryState}: ${NAIRA}${order.shippingFee.toLocaleString()}</p>` : ''}
      <p style="font-size:18px;font-weight:bold;">Total: ${NAIRA}${order.total.toLocaleString()}</p>
      <p style="font-size:13px;color:#6B7280;">Delivering to: ${order.deliveryAddress}, ${order.deliveryCity}, ${order.deliveryState}</p>
      <p style="font-size:13px;color:#9CA3AF;margin-top:24px;">This email confirms your order was received. The seller will be in touch about delivery.</p>
    </div>
  `;
}

function SkeletonBlock({ width, height, radius = 8 }: { width: string | number; height: number; radius?: number }) {
  return <div className="sp-skel" style={{ width, height, borderRadius: radius }} />;
}

function LoadingSpinner() {
  return (
    <div style={{ minHeight: '100vh', background: '#fff', padding: 16 }}>
      <style>{`
        @keyframes sp-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
        .sp-skel { background: #EAEAEA; animation: sp-pulse 1.3s ease-in-out infinite; }
      `}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <SkeletonBlock width={40} height={40} radius={10} />
        <SkeletonBlock width={110} height={16} radius={6} />
      </div>
      <div style={{ marginBottom: 20 }}>
        <SkeletonBlock width="100%" height={44} radius={12} />
      </div>
      <div style={{ marginBottom: 24 }}>
        <SkeletonBlock width="100%" height={150} radius={20} />
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
        {[0, 1, 2, 3].map(i => <SkeletonBlock key={i} width={70} height={30} radius={20} />)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i}>
            <SkeletonBlock width="100%" height={160} radius={16} />
            <div style={{ marginTop: 8 }}><SkeletonBlock width="80%" height={12} radius={6} /></div>
            <div style={{ marginTop: 6 }}><SkeletonBlock width="50%" height={14} radius={6} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StoreNotFound() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'Inter, sans-serif', textAlign: 'center' as const }}>
      <ShoppingBag size={40} color="#9CA3AF" style={{ marginBottom: 16 }} />
      <h2 style={{ fontSize: 20, fontWeight: 700, color: '#111827', marginBottom: 8 }}>Store not found</h2>
      <p style={{ fontSize: 14, color: '#6B7280' }}>This store link doesn't exist or may have been removed.</p>
    </div>
  );
}

function DarkHeader({ theme, merchant, slug, backHref, showBack, onWishlistClick, wishlistActive, onSearchClick, searchActive }: { theme: StoreTheme; merchant: MerchantInfo; slug: string; backHref?: string; showBack?: boolean; onWishlistClick?: () => void; wishlistActive?: boolean; onSearchClick?: () => void; searchActive?: boolean }) {
  const cartCount = useListCount('cart', slug, true);
  const wishlistCount = useListCount('wishlist', slug);
  return (
    <div style={{ position: 'sticky' as const, top: 0, zIndex: 30, background: theme.secondary, transition: 'background 0.5s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px 10px', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          {showBack ? (
            <Link to={backHref || `/${slug}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 9, background: 'rgba(255,255,255,0.1)', flexShrink: 0 }}>
              <ArrowLeft size={16} color="#fff" />
            </Link>
          ) : (
            <button style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0 }}>
              <Menu size={20} color="#fff" />
            </button>
          )}
          {(() => {
            const displayLogo = isProAccess(merchant) ? merchant.logoUrl : (PLATFORM_LOGO_URL || merchant.logoUrl);
            return displayLogo ? (
              <img src={displayLogo} alt={merchant.storeName} style={{ width: 30, height: 30, borderRadius: 8, objectFit: 'cover' as const, flexShrink: 0 }} />
            ) : null;
          })()}
          <div style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 7 }}>
            <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 800, color: theme.accent, lineHeight: 1, transition: 'color 0.4s ease', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' as const }}>
              {merchant.storeName || 'Store'}
            </h1>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {onSearchClick && (
            <button onClick={onSearchClick} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 5 }}>
              <Search size={19} color={searchActive ? theme.accent : '#fff'} />
            </button>
          )}
          <div style={{ position: 'relative' as const }}>
            <button onClick={onWishlistClick} style={{ background: 'none', border: 'none', cursor: onWishlistClick ? 'pointer' : 'default', padding: 5 }}>
              <Heart size={19} color={wishlistActive ? theme.accent : '#fff'} fill={wishlistActive ? theme.accent : 'none'} />
            </button>
            {wishlistCount > 0 && (
              <span style={{ position: 'absolute' as const, top: -1, right: -1, background: theme.accent, color: theme.secondary, fontSize: 8.5, fontWeight: 800, width: 15, height: 15, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{wishlistCount}</span>
            )}
          </div>
          <div style={{ position: 'relative' as const }}>
            <Link to={`/${slug}/checkout`} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 5, display: 'flex' }}>
              <ShoppingCart size={19} color="#fff" />
            </Link>
            {cartCount > 0 && (
              <span style={{ position: 'absolute' as const, top: -1, right: -1, background: theme.accent, color: theme.secondary, fontSize: 8.5, fontWeight: 800, width: 15, height: 15, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{cartCount}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SaleCountdownBanner({ merchant, theme }: { merchant: MerchantInfo; theme: StoreTheme }) {
  const [timeLeft, setTimeLeft] = useState<{ d: number; h: number; m: number; s: number } | null>(null);

  useEffect(() => {
    if (!merchant.saleEndsAt) { setTimeLeft(null); return; }
    const target = new Date(merchant.saleEndsAt).getTime();
    const tick = () => {
      const diff = target - Date.now();
      if (diff <= 0) { setTimeLeft(null); return; }
      setTimeLeft({
        d: Math.floor(diff / (1000 * 60 * 60 * 24)),
        h: Math.floor((diff / (1000 * 60 * 60)) % 24),
        m: Math.floor((diff / (1000 * 60)) % 60),
        s: Math.floor((diff / 1000) % 60),
      });
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [merchant.saleEndsAt]);

  if (!timeLeft) return null;

  const Unit = ({ value, label }: { value: number; label: string }) => (
    <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center' }}>
      <div style={{ background: 'rgba(255,255,255,0.15)', borderRadius: 8, padding: '5px 8px', minWidth: 36 }}>
        <span style={{ fontSize: 15, fontWeight: 800, color: '#fff', fontVariantNumeric: 'tabular-nums' as const }}>{String(value).padStart(2, '0')}</span>
      </div>
      <span style={{ fontSize: 8.5, color: 'rgba(255,255,255,0.7)', fontWeight: 700, marginTop: 3, textTransform: 'uppercase' as const }}>{label}</span>
    </div>
  );

  return (
    <div style={{ background: theme.primary, padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, transition: 'background 0.5s ease' }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>{merchant.saleLabel || 'Sale ends in'}</span>
      <div style={{ display: 'flex', gap: 6 }}>
        {timeLeft.d > 0 && <Unit value={timeLeft.d} label="Days" />}
        <Unit value={timeLeft.h} label="Hrs" />
        <Unit value={timeLeft.m} label="Min" />
        <Unit value={timeLeft.s} label="Sec" />
      </div>
    </div>
  );
}

function FloatingWhatsApp({ merchant, theme, productName }: { merchant: MerchantInfo; theme: StoreTheme; productName?: string }) {
  if (!merchant.contactWhatsapp) return null;
  const text = productName ? `Hi, I'm interested in ${productName}` : `Hi, I have a question about your store`;
  return (
    <a
      href={`https://wa.me/${merchant.contactWhatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`}
      target="_blank"
      rel="noreferrer"
      style={{
        position: 'fixed' as const, bottom: 20, right: 18, width: 54, height: 54, borderRadius: '50%',
        background: '#25D366', display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 6px 18px rgba(0,0,0,0.25)', zIndex: 50, textDecoration: 'none',
      }}
    >
      <MessageCircle size={26} color="#fff" fill="#fff" />
    </a>
  );
}

// Builds a Bumpa-style page number list with ellipsis for many pages, e.g. [1,2,3,4,'...',7]
function getPageNumbers(current: number, total: number): (number | '...')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | '...')[] = [1];
  if (current > 3) pages.push('...');
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  for (let i = start; i <= end; i++) pages.push(i);
  if (current < total - 2) pages.push('...');
  pages.push(total);
  return pages;
}

function StoreFooter({ merchant, theme, slug }: { merchant: MerchantInfo; theme: StoreTheme; slug: string }) {
  return (
    <div style={{ background: theme.secondary, padding: '28px 20px 24px', transition: 'background 0.5s ease' }}>
      <Link to={`/${slug}`} style={{ color: '#fff', fontSize: 13, fontWeight: 700, textDecoration: 'none', display: 'block', marginBottom: 10 }}>Home</Link>
      <Link to={`/${slug}/track`} style={{ color: '#fff', fontSize: 13, fontWeight: 700, textDecoration: 'none', display: 'block', marginBottom: 18 }}>Track My Order</Link>

      <p style={{ color: theme.accent, fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase' as const, marginBottom: 12 }}>Contact Us</p>

      {merchant.contactWhatsapp && (
        <a href={`tel:${merchant.contactWhatsapp.replace(/\D/g, '')}`} style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'rgba(255,255,255,0.85)', fontSize: 13, textDecoration: 'none', marginBottom: 10 }}>
          <Phone size={14} color={theme.accent} /> {merchant.contactWhatsapp}
        </a>
      )}

      {merchant.contactEmail && (
        <a href={`mailto:${merchant.contactEmail}`} style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'rgba(255,255,255,0.85)', fontSize: 13, textDecoration: 'none', marginBottom: 10 }}>
          <MessageCircle size={14} color={theme.accent} /> {merchant.contactEmail}
        </a>
      )}

      {merchant.storeAddress && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, color: 'rgba(255,255,255,0.85)', fontSize: 13, lineHeight: 1.5, marginBottom: 4 }}>
          <MapPin size={14} color={theme.accent} style={{ marginTop: 2, flexShrink: 0 }} /> <span>{merchant.storeAddress}</span>
        </div>
      )}

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.12)', marginTop: 20, paddingTop: 16, textAlign: 'center' as const }}>
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5 }}>POWERED BY SALESPILOT</p>
      </div>
    </div>
  );
}

function ProductCard({ product, theme, slug, wishlistIds }: { product: Product; theme: StoreTheme; slug: string; wishlistIds: string[] }) {
  const discount = product.salePrice ? Math.round((1 - product.salePrice / product.price) * 100) : 0;
  const wished = wishlistIds.includes(product.id);
  return (
    <Link to={`/${slug}/product/${product.id}`} className="sp-card" style={{ textDecoration: 'none', display: 'block', width: '100%', height: '100%', minWidth: 0 }}>
      <div style={{ background: theme.background, borderRadius: 20, overflow: 'hidden', border: `1px solid ${theme.accent}44`, boxShadow: '0 2px 8px rgba(0,0,0,0.05)', transition: 'transform 0.15s ease', display: 'flex', flexDirection: 'column' as const, height: '100%', minWidth: 0 }}>
        <div style={{ width: '100%', aspectRatio: '1', background: `linear-gradient(135deg, ${theme.primary}12, ${theme.secondary}0a)`, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' as const, overflow: 'hidden', flexShrink: 0 }}>
          {product.imageUrl ? (
            <img src={getOptimizedImageUrl(product.imageUrl, 300)} alt={product.name} style={{ width: '100%', height: '100%', objectFit: 'cover' as const, display: 'block' }} loading="lazy" />
          ) : (
            <ProductIcon iconKey={product.emoji} size={40} color={theme.primary} />
          )}
          {product.badge !== 'None' && (
            <div style={{ position: 'absolute' as const, top: 10, left: 10, background: theme.primary, color: '#fff', fontSize: 10, fontWeight: 800, padding: '4px 10px', borderRadius: 20, letterSpacing: 0.3 }}>{product.badge}</div>
          )}
          {discount > 0 && (
            <div style={{ position: 'absolute' as const, top: 10, right: 44, background: '#EF4444', color: '#fff', fontSize: 10, fontWeight: 800, padding: '4px 8px', borderRadius: 20 }}>-{discount}%</div>
          )}
          <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleWishlistItem(slug, product.id); }} style={{ position: 'absolute' as const, top: 8, right: 8, background: 'rgba(255,255,255,0.9)', border: 'none', borderRadius: '50%', width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <Heart size={14} color={wished ? '#EF4444' : '#9CA3AF'} fill={wished ? '#EF4444' : 'none'} />
          </button>
        </div>
        <div style={{ padding: '12px 13px 14px', textAlign: 'center' as const, flex: 1, display: 'flex', flexDirection: 'column' as const, justifyContent: 'center' as const }}>
          <p style={{ fontSize: 13.5, fontWeight: 700, color: '#111827', marginBottom: 7, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' as const }}>{product.name}</p>
          {product.salePrice ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' as const, gap: 6 }}>
              <span style={{ fontSize: 15, fontWeight: 800, color: theme.primary }}>{NAIRA}{product.salePrice.toLocaleString()}</span>
              <span style={{ fontSize: 11, color: '#9CA3AF', textDecoration: 'line-through' }}>{NAIRA}{product.price.toLocaleString()}</span>
            </div>
          ) : (
            <span style={{ fontSize: 15, fontWeight: 800, color: theme.primary }}>{NAIRA}{product.price.toLocaleString()}</span>
          )}
        </div>
      </div>
    </Link>
  );
}

function usePaystackScript() {
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

export function CheckoutScreen() {
  const { slug } = useParams();
  const navigate = useNavigate();
  usePremiumFont();
  const { merchant, loading, notFound } = useMerchantBySlug(slug);
  useTrackingScripts(merchant);
  const cart = useCart(slug);
  const { secondsLeft, justExpired } = useCartTimer(merchant?.cartTimerMinutes, slug, cart.length);
  const paystackReady = usePaystackScript();

  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [deliveryState, setDeliveryState] = useState('');
  const [deliveryCity, setDeliveryCity] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [selectedCourierId, setSelectedCourierId] = useState<string | null>(null);
  const [customFieldAnswers, setCustomFieldAnswers] = useState<{ [id: string]: string }>({});
  const [termsChecked, setTermsChecked] = useState(false);
  const [couponInput, setCouponInput] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<{ id: string; code: string; type: 'percent' | 'fixed'; value: number } | null>(null);
  const [couponError, setCouponError] = useState('');
  const [checkingCoupon, setCheckingCoupon] = useState(false);
  const [formError, setFormError] = useState('');
  const [placing, setPlacing] = useState(false);
  const [completedOrder, setCompletedOrder] = useState<Order | null>(null);

  // Abandoned cart recovery: quietly save this customer's email and cart contents as soon as
  // they type a valid-looking email, so if they never finish checkout, a recovery email can go
  // out later. Reuses the same start-time stamp as the cart timer, so re-typing doesn't reset
  // the "how long ago did they abandon" clock. Computes its own total independently since it
  // must run before merchant/shippingFee data is guaranteed loaded (hooks can't follow an
  // early return). This is a Pro feature - non-Pro merchants simply don't get leads captured.
  useEffect(() => {
    if (!merchant?.uid || !slug) return;
    if (!isProAccess(merchant)) return;
    if (!customerEmail.trim() || !customerEmail.includes('@')) return;
    if (cart.length === 0) return;
    const cartTotal = cart.reduce((s, i) => s + getTieredPrice(i.price, i.priceTiers, i.quantity) * i.quantity, 0);
    const timeout = setTimeout(() => {
      let leadId: string;
      try {
        let stored = sessionStorage.getItem(`sp_lead_id_${slug}`);
        if (!stored) { stored = Math.random().toString(36).slice(2, 12); sessionStorage.setItem(`sp_lead_id_${slug}`, stored); }
        leadId = stored;
        const startedAt = sessionStorage.getItem(`sp_cart_started_${slug}`);
        setDoc(doc(db, 'merchants', merchant.uid, 'cartLeads', leadId), {
          email: customerEmail.trim(),
          items: cart.map(c => ({ name: c.name, price: getTieredPrice(c.price, c.priceTiers, c.quantity), quantity: c.quantity })),
          cartTotal,
          createdAt: startedAt ? new Date(Number(startedAt)).toISOString() : new Date().toISOString(),
          recoveryEmailSent: false,
          converted: false,
        }, { merge: true }).catch(err => console.error('Could not save cart lead:', err));
      } catch (err) {
        console.error('Could not save cart lead:', err);
      }
    }, 1500);
    return () => clearTimeout(timeout);
  }, [customerEmail, cart, merchant?.uid, slug]);

  if (loading) return <LoadingSpinner />;
  if (notFound || !merchant) return <StoreNotFound />;
  const theme = getTheme(merchant.themeId);

  const subtotal = cart.reduce((s, i) => s + getTieredPrice(i.price, i.priceTiers, i.quantity) * i.quantity, 0);
  const discount = appliedCoupon
    ? appliedCoupon.type === 'percent'
      ? Math.round(subtotal * appliedCoupon.value / 100)
      : Math.min(appliedCoupon.value, subtotal)
    : 0;
  const total = subtotal - discount;
  const activeCouriers = (merchant.couriers || []).filter(c => c.active);
  const selectedCourier = activeCouriers.find(c => c.id === selectedCourierId) || null;
  const shippingFee = activeCouriers.length > 0
    ? (selectedCourier ? getCourierCustomerPrice(selectedCourier) : 0)
    : (deliveryState ? (merchant.shippingRates?.[deliveryState] ?? merchant.defaultShippingFee ?? 0) : 0);
  const platformFee = merchant.feePaidByCustomer ? getPlatformOrderFee(subtotal) : 0;
  const grandTotal = total + shippingFee + platformFee;
  // The exact amount that should reach the platform's main account on this specific order -
  // always getPlatformOrderFee(subtotal), regardless of who's paying it. If the customer is
  // covering the fee, this amount is already sitting in what they paid on top; if the merchant
  // is absorbing it, this same amount is meant to come out of their own share instead. Passing
  // this as a fixed transaction_charge (rather than relying on the subaccount's own default
  // percentage split) is what keeps these two amounts from ever being taken twice.
  const mainAccountCharge = getPlatformOrderFee(subtotal);

  const handleApplyCoupon = async () => {
    setCouponError('');
    const code = couponInput.trim().toUpperCase();
    if (!code) return;
    setCheckingCoupon(true);
    try {
      const q = query(collection(db, 'merchants', merchant.uid, 'coupons'), where('code', '==', code));
      const snap = await getDocs(q);
      if (snap.empty) { setCouponError('That code is not valid.'); return; }
      const c: any = snap.docs[0].data();
      if (!c.active) { setCouponError('That code is no longer active.'); return; }
      const today = new Date().toISOString().slice(0, 10);
      if (c.startDate && today < c.startDate) { setCouponError('That code is not active yet.'); return; }
      if (c.endDate && today > c.endDate) { setCouponError('That code has expired.'); return; }
      if (c.usageLimit !== null && c.usageLimit !== undefined && c.usedCount >= c.usageLimit) { setCouponError('That code has reached its usage limit.'); return; }
      setAppliedCoupon({ id: snap.docs[0].id, code, type: c.type, value: c.value });
    } catch {
      setCouponError('Could not check that code. Please try again.');
    } finally {
      setCheckingCoupon(false);
    }
  };

  const persistOrder = async (paymentMethod: 'Paystack' | 'WhatsApp', reference: string) => {
    const items: OrderItem[] = cart.map(c => {
      const item: OrderItem = { name: c.name, price: getTieredPrice(c.price, c.priceTiers, c.quantity), quantity: c.quantity };
      if (c.productId) item.productId = c.productId;
      if (c.options && Object.keys(c.options).length > 0) item.options = c.options;
      return item;
    });
    const order: Order = {
      id: reference,
      reference,
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim(),
      ...(customerPhone.trim() ? { customerPhone: customerPhone.trim() } : {}),
      deliveryState: deliveryState.trim(),
      deliveryCity: deliveryCity.trim(),
      deliveryAddress: deliveryAddress.trim(),
      items,
      subtotal,
      discount,
      ...(appliedCoupon?.code ? { couponCode: appliedCoupon.code } : {}),
      shippingFee,
      ...(selectedCourier ? { courierName: selectedCourier.name } : {}),
      ...((merchant.checkoutFields && merchant.checkoutFields.length > 0)
        ? { customFields: merchant.checkoutFields.filter(f => (customFieldAnswers[f.id] || '').trim()).map(f => ({ label: f.label, value: customFieldAnswers[f.id].trim() })) }
        : {}),
      ...(() => { try { const s = sessionStorage.getItem(`sp_source_${slug}`); return s ? { source: s } : {}; } catch { return {}; } })(),
      ...(merchant.termsAndConditions && termsChecked
        ? { termsAccepted: true, termsAcceptedText: merchant.termsAndConditions, termsAcceptedAt: new Date().toISOString() }
        : {}),
      total: grandTotal,
      paymentMethod,
      status: paymentMethod === 'Paystack' ? 'Completed' : 'Pending',
      createdAt: new Date().toISOString(),
      accessToken: Math.random().toString(36).slice(2, 12),
    };
    await setDoc(doc(db, 'merchants', merchant.uid, 'orders', reference), order);
    if (appliedCoupon) {
      try { await setDoc(doc(db, 'merchants', merchant.uid, 'coupons', appliedCoupon.id), { usedCount: increment(1) }, { merge: true }); } catch (err) { console.error('Could not update coupon usage count:', err); }
    }
    await decrementStockAfterOrder(merchant.uid, items);
    trackStoreEvent('Purchase', { value: grandTotal, currency: 'NGN' });
    sendStoreEmail(order.customerEmail, `Order Confirmed - ${merchant.storeName || 'Your Order'}`, buildOrderConfirmationEmail(order, merchant.storeName || 'Our Store'));
    pushNotification(merchant.uid, `New order from ${order.customerName || 'a customer'} - ${NAIRA}${grandTotal.toLocaleString()}`, 'new-order');
    try {
      const leadId = sessionStorage.getItem(`sp_lead_id_${slug}`);
      if (leadId) await setDoc(doc(db, 'merchants', merchant.uid, 'cartLeads', leadId), { converted: true }, { merge: true });
    } catch (err) { console.error('Could not mark cart lead converted:', err); }
    clearCart(slug!);
    setCompletedOrder(order);
  };

  const handlePlaceOrder = async () => {
    setFormError('');
    if (!customerName.trim()) { setFormError('Please enter your name.'); return; }
    if (!customerEmail.trim() || !customerEmail.includes('@')) { setFormError('Please enter a valid email.'); return; }
    if (!deliveryState.trim() || !deliveryCity.trim() || !deliveryAddress.trim()) { setFormError('Please enter your full delivery address, including state, so the seller knows where to send your order.'); return; }
    if (activeCouriers.length > 0 && !selectedCourier) { setFormError('Please choose a delivery courier.'); return; }
    for (const f of (merchant.checkoutFields || [])) {
      if (f.required && !(customFieldAnswers[f.id] || '').trim()) { setFormError(`Please fill in "${f.label}".`); return; }
    }
    if (merchant.termsAndConditions && merchant.termsRequired !== false && !termsChecked) {
      setFormError('Please agree to the terms and conditions to check out.');
      return;
    }
    if (cart.length === 0) { setFormError('Your cart is empty.'); return; }
    if (!paystackReady) { setFormError('Payment is still loading - please wait a moment and try again.'); return; }

    const reference = `SP${Date.now()}`;
    setPlacing(true);
    const handler = (window as any).PaystackPop.setup({
      key: PAYSTACK_PUBLIC_KEY,
      email: customerEmail.trim(),
      amount: Math.round(grandTotal * 100),
      currency: 'NGN',
      ref: reference,
      // If this merchant has a real Paystack Subaccount set up, the payment automatically
      // splits: the exact platform commission (mainAccountCharge) stays with the main account,
      // and the rest settles directly to the merchant's own bank account, no manual payout
      // needed. Passing transaction_charge as a fixed amount (rather than letting the
      // subaccount's own default percentage apply) is what keeps this correct regardless of
      // whether the merchant or the customer is the one covering the platform fee. Merchants
      // who haven't added their bank details yet simply don't have a subaccount code, and
      // checkout works exactly as it always has, everything landing in the main account.
      ...(merchant.paystackSubaccountCode ? {
        subaccount: merchant.paystackSubaccountCode,
        transaction_charge: Math.round(mainAccountCharge * 100),
        bearer: 'account',
      } : {}),
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
              await persistOrder('Paystack', response.reference);
            } else {
              setFormError('We could not confirm your payment went through. If money left your account, please contact the seller with your reference: ' + response.reference);
            }
          } catch (err: any) {
            console.error('Payment verification failed:', err);
            setFormError('We could not confirm your payment right now. If money left your account, please contact the seller with your reference: ' + response.reference);
          } finally {
            setPlacing(false);
          }
        })();
      },
      onClose: () => setPlacing(false),
    });
    handler.openIframe();
  };

  if (completedOrder) {
    const waText = `Hi, I just placed an order (Ref: ${completedOrder.reference}) for ${NAIRA}${completedOrder.total.toLocaleString()}${completedOrder.shippingFee > 0 ? ` (includes ${NAIRA}${completedOrder.shippingFee.toLocaleString()} delivery to ${completedOrder.deliveryState})` : ''}. ${completedOrder.paymentMethod === 'WhatsApp' ? "I'd like to arrange payment." : "My payment reference is above."} My order link: ${window.location.origin}/${slug}/order/${completedOrder.reference}/${completedOrder.accessToken}`;
    return (
      <div style={{ minHeight: '100vh', background: theme.background, fontFamily: 'Inter, sans-serif', display: 'flex', flexDirection: 'column' as const }}>
        <DarkHeader theme={theme} merchant={merchant} slug={slug!} backHref={`/${slug}`} showBack />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', padding: 32, textAlign: 'center' as const }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: `${theme.primary}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
            <CheckCircle2 size={32} color={theme.primary} />
          </div>
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 21, fontWeight: 800, color: '#111827', marginBottom: 8 }}>
            {completedOrder.paymentMethod === 'Paystack' ? 'Payment received!' : 'Order placed!'}
          </h2>
          <p style={{ fontSize: 13.5, color: '#6B7280', marginBottom: 6, maxWidth: 280 }}>
            {completedOrder.paymentMethod === 'Paystack'
              ? "We've got your order and payment. The seller will confirm and get your order moving."
              : "Your order is saved. Message the seller on WhatsApp to arrange payment and delivery."}
          </p>
          <p style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 4 }}>Order reference: {completedOrder.reference}</p>
          <p style={{ fontSize: 11.5, color: '#9CA3AF', marginBottom: 26 }}>Tap below anytime to see your order status - no need to type anything in.</p>
          {merchant.contactWhatsapp && (
            <a href={`https://wa.me/${merchant.contactWhatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(waText)}`} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: theme.primary, color: '#fff', border: 'none', borderRadius: 14, padding: '13px 22px', fontSize: 14, fontWeight: 800, textDecoration: 'none', marginBottom: 14 }}>
              <MessageCircle size={16} /> Message Seller on WhatsApp
            </a>
          )}
          <div style={{ display: 'flex', gap: 18 }}>
            <Link to={`/${slug}/order/${completedOrder.reference}/${completedOrder.accessToken}`} style={{ color: theme.primary, fontSize: 13, fontWeight: 700, textDecoration: 'none' }}>View My Order</Link>
            <Link to={`/${slug}`} style={{ color: '#9CA3AF', fontSize: 13, fontWeight: 700, textDecoration: 'none' }}>Continue Shopping</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: theme.background, fontFamily: 'Inter, sans-serif', paddingBottom: 40, overflowX: 'hidden' as const }}>
      <style>{`* { box-sizing: border-box; }`}</style>
      <DarkHeader theme={theme} merchant={merchant} slug={slug!} backHref={`/${slug}`} showBack />

      <div style={{ padding: '18px 20px 0' }}>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 21, fontWeight: 800, color: '#111827', marginBottom: 18 }}>Checkout</h1>

        {secondsLeft !== null && secondsLeft > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: secondsLeft < 120 ? '#FEE2E2' : `${theme.primary}12`, borderRadius: 12, padding: '10px 14px', marginBottom: 16 }}>
            <Clock size={15} color={secondsLeft < 120 ? '#EF4444' : theme.primary} />
            <span style={{ fontSize: 12.5, fontWeight: 700, color: secondsLeft < 120 ? '#EF4444' : theme.primary }}>
              Your cart is reserved for {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')} - complete checkout before it clears
            </span>
          </div>
        )}

        {cart.length === 0 ? (
          <div style={{ textAlign: 'center' as const, padding: '50px 0' }}>
            <ShoppingBag size={32} color="#D1D5DB" style={{ marginBottom: 12 }} />
            <p style={{ fontSize: 14, color: '#6B7280', marginBottom: 6 }}>
              {justExpired ? "Your cart reservation ran out, so it's been cleared." : 'Your cart is empty.'}
            </p>
            {justExpired && <p style={{ fontSize: 12.5, color: '#9CA3AF', marginBottom: 16 }}>No worries - just add your items again to keep shopping.</p>}
            <Link to={`/${slug}`} style={{ color: theme.primary, fontSize: 13, fontWeight: 700, textDecoration: 'none' }}>Continue Shopping</Link>
          </div>
        ) : (
          <>
            {/* Cart items */}
            <div style={{ marginBottom: 22 }}>
              {cart.map((item, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid #F3F4F6' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 13.5, fontWeight: 700, color: '#111827', marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>{item.name}</p>
                    {item.bundleName && (
                      <p style={{ fontSize: 10.5, color: theme.primary, fontWeight: 700, marginBottom: 3 }}>Part of: {item.bundleName}</p>
                    )}
                    {item.options && Object.keys(item.options).length > 0 && (
                      <p style={{ fontSize: 11.5, color: '#9CA3AF', marginBottom: 3 }}>{Object.values(item.options).join(', ')}</p>
                    )}
                    <p style={{ fontSize: 13, fontWeight: 700, color: theme.primary }}>{NAIRA}{getTieredPrice(item.price, item.priceTiers, item.quantity).toLocaleString()}{item.priceTiers?.length ? ' each' : ''}</p>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 10, padding: '5px 10px', flexShrink: 0 }}>
                    <button onClick={() => updateCartQuantity(slug!, i, Math.max(item.minOrderQty || 1, item.quantity - 1))} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex' }}><Minus size={13} /></button>
                    <span style={{ fontSize: 13, fontWeight: 700, minWidth: 16, textAlign: 'center' as const }}>{item.quantity}</span>
                    <button onClick={() => updateCartQuantity(slug!, i, item.maxOrderQty ? Math.min(item.maxOrderQty, item.quantity + 1) : item.quantity + 1)} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex' }}><Plus size={13} /></button>
                  </div>
                  <button onClick={() => removeFromCart(slug!, i)} style={{ background: '#FEE2E2', border: 'none', borderRadius: 8, width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
                    <X size={13} color="#EF4444" />
                  </button>
                </div>
              ))}
            </div>

            {/* Coupon */}
            <div style={{ marginBottom: 22 }}>
              {appliedCoupon ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#DCFCE7', borderRadius: 12, padding: '10px 14px' }}>
                  <span style={{ fontSize: 12.5, color: '#16A34A', fontWeight: 700 }}>Code "{appliedCoupon.code}" applied</span>
                  <button onClick={() => { setAppliedCoupon(null); setCouponInput(''); }} style={{ background: 'none', border: 'none', color: '#16A34A', cursor: 'pointer', display: 'flex' }}><X size={15} /></button>
                </div>
              ) : (
                <div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      style={{ flex: 1, padding: '11px 14px', borderRadius: 11, border: '1px solid #E5E7EB', fontSize: 13, outline: 'none', textTransform: 'uppercase' as const }}
                      placeholder="Coupon code"
                      value={couponInput}
                      onChange={e => setCouponInput(e.target.value)}
                    />
                    <button onClick={handleApplyCoupon} disabled={checkingCoupon || !couponInput.trim()} style={{ background: theme.primary, color: '#fff', border: 'none', borderRadius: 11, padding: '0 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: checkingCoupon || !couponInput.trim() ? 0.6 : 1 }}>
                      {checkingCoupon ? '...' : 'Apply'}
                    </button>
                  </div>
                  {couponError && <p style={{ color: '#EF4444', fontSize: 12, marginTop: 6 }}>{couponError}</p>}
                </div>
              )}
            </div>

            {/* Order summary */}
            <div style={{ background: '#F9FAFB', borderRadius: 14, padding: 16, marginBottom: 22 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: '#6B7280' }}>Subtotal</span>
                <span style={{ fontSize: 13, color: '#111827', fontWeight: 600 }}>{NAIRA}{subtotal.toLocaleString()}</span>
              </div>
              {discount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: '#16A34A' }}>Discount</span>
                  <span style={{ fontSize: 13, color: '#16A34A', fontWeight: 600 }}>-{NAIRA}{discount.toLocaleString()}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: '#6B7280' }}>
                  {activeCouriers.length > 0
                    ? (selectedCourier ? `Delivery via ${selectedCourier.name}` : 'Delivery')
                    : (deliveryState ? `Delivery to ${deliveryState}` : 'Delivery')}
                </span>
                <span style={{ fontSize: 13, color: '#111827', fontWeight: 600 }}>
                  {activeCouriers.length > 0
                    ? (selectedCourier ? `${NAIRA}${shippingFee.toLocaleString()}` : 'Select courier')
                    : (deliveryState ? (shippingFee > 0 ? `${NAIRA}${shippingFee.toLocaleString()}` : 'Free') : 'Select state')}
                </span>
              </div>
              {platformFee > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: '#6B7280' }}>Platform fee</span>
                  <span style={{ fontSize: 13, color: '#111827', fontWeight: 600 }}>{NAIRA}{platformFee.toLocaleString()}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 10, borderTop: '1px solid #E5E7EB' }}>
                <span style={{ fontSize: 15, color: '#111827', fontWeight: 800 }}>Total</span>
                <span style={{ fontSize: 17, color: theme.primary, fontWeight: 800 }}>{NAIRA}{grandTotal.toLocaleString()}</span>
              </div>
              {shippingFee > 0 && <p style={{ fontSize: 11, color: '#9CA3AF', marginTop: 6 }}>Includes {NAIRA}{shippingFee.toLocaleString()} delivery fee to {deliveryState}.</p>}
            </div>

            {/* Customer info */}
            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 12 }}>Your details</p>
              <input style={{ width: '100%', padding: '12px 14px', borderRadius: 11, border: '1px solid #E5E7EB', fontSize: 13.5, outline: 'none', marginBottom: 10, boxSizing: 'border-box' as const }} placeholder="Full name" value={customerName} onChange={e => setCustomerName(e.target.value)} />
              <input style={{ width: '100%', padding: '12px 14px', borderRadius: 11, border: '1px solid #E5E7EB', fontSize: 13.5, outline: 'none', marginBottom: 10, boxSizing: 'border-box' as const }} placeholder="Email address" type="email" value={customerEmail} onChange={e => setCustomerEmail(e.target.value)} />
              <input style={{ width: '100%', padding: '12px 14px', borderRadius: 11, border: '1px solid #E5E7EB', fontSize: 13.5, outline: 'none', boxSizing: 'border-box' as const }} placeholder="Phone number (optional)" value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} />
            </div>

            {/* Delivery address */}
            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 4 }}>Delivery address</p>
              <p style={{ fontSize: 11.5, color: '#9CA3AF', marginBottom: 12 }}>So the seller knows exactly where to send your order.</p>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <select style={{ flex: 1, padding: '12px 14px', borderRadius: 11, border: '1px solid #E5E7EB', fontSize: 13.5, outline: 'none', boxSizing: 'border-box' as const, minWidth: 0, background: '#fff', color: deliveryState ? '#111827' : '#9CA3AF' }} value={deliveryState} onChange={e => setDeliveryState(e.target.value)}>
                  <option value="">State</option>
                  {NIGERIAN_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <input style={{ flex: 1, padding: '12px 14px', borderRadius: 11, border: '1px solid #E5E7EB', fontSize: 13.5, outline: 'none', boxSizing: 'border-box' as const, minWidth: 0 }} placeholder="City / Area" value={deliveryCity} onChange={e => setDeliveryCity(e.target.value)} />
              </div>
              <textarea style={{ width: '100%', padding: '12px 14px', borderRadius: 11, border: '1px solid #E5E7EB', fontSize: 13.5, outline: 'none', minHeight: 68, resize: 'vertical' as const, fontFamily: 'inherit', boxSizing: 'border-box' as const }} placeholder="Full address - street, house number, landmark" value={deliveryAddress} onChange={e => setDeliveryAddress(e.target.value)} />
            </div>

            {activeCouriers.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 4 }}>Choose a delivery courier</p>
                <p style={{ fontSize: 11.5, color: '#9CA3AF', marginBottom: 12 }}>Pick how you'd like your order delivered.</p>
                {activeCouriers.map(c => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedCourierId(c.id)}
                    style={{
                      width: '100%', textAlign: 'left' as const, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      background: selectedCourierId === c.id ? `${theme.primary}0d` : '#fff',
                      border: `1.5px solid ${selectedCourierId === c.id ? theme.primary : '#E5E7EB'}`,
                      borderRadius: 12, padding: '12px 14px', marginBottom: 8, cursor: 'pointer',
                    }}
                  >
                    <div>
                      <p style={{ fontSize: 13.5, fontWeight: 700, color: '#111827' }}>{c.name}</p>
                      {c.estimatedDays && <p style={{ fontSize: 11.5, color: '#9CA3AF', marginTop: 2 }}>{c.estimatedDays}</p>}
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 800, color: theme.primary }}>{NAIRA}{getCourierCustomerPrice(c).toLocaleString()}</span>
                  </button>
                ))}
              </div>
            )}

            {merchant.checkoutFields && merchant.checkoutFields.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                {merchant.checkoutFields.map(f => (
                  <div key={f.id} style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 13, fontWeight: 700, color: '#111827', display: 'block', marginBottom: 6 }}>
                      {f.label}{f.required && <span style={{ color: '#EF4444' }}> *</span>}
                    </label>
                    <input
                      style={{ width: '100%', padding: '12px 14px', borderRadius: 11, border: '1px solid #E5E7EB', fontSize: 13.5, outline: 'none', boxSizing: 'border-box' as const }}
                      value={customFieldAnswers[f.id] || ''}
                      onChange={e => setCustomFieldAnswers({ ...customFieldAnswers, [f.id]: e.target.value })}
                    />
                  </div>
                ))}
              </div>
            )}

            {merchant.termsAndConditions && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 12, padding: 14, maxHeight: 140, overflowY: 'auto' as const, marginBottom: 10 }}>
                  <p style={{ fontSize: 12, color: '#4B5563', lineHeight: 1.6, whiteSpace: 'pre-wrap' as const }}>{merchant.termsAndConditions}</p>
                </div>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: '#374151', cursor: 'pointer' }}>
                  <input type="checkbox" checked={termsChecked} onChange={e => setTermsChecked(e.target.checked)} style={{ marginTop: 2 }} />
                  I have read and agree to the terms and conditions above
                </label>
              </div>
            )}

            {formError && <p style={{ color: '#EF4444', fontSize: 12.5, marginBottom: 14 }}>{formError}</p>}

            <button
              onClick={handlePlaceOrder}
              disabled={placing}
              style={{ width: '100%', background: theme.primary, color: '#fff', border: 'none', borderRadius: 15, padding: 16, fontSize: 15, fontWeight: 800, cursor: 'pointer', opacity: placing ? 0.7 : 1, marginBottom: 10 }}
            >
              {placing ? 'Please wait...' : `Pay ${NAIRA}${grandTotal.toLocaleString()} with Paystack`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}


function OrderStatusStepper({ status, theme }: { status: Order['status']; theme: StoreTheme }) {
  if (status === 'Cancelled') {
    return (
      <div style={{ background: '#FEE2E2', borderRadius: 14, padding: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
        <X size={20} color="#EF4444" />
        <div>
          <p style={{ fontSize: 14, fontWeight: 800, color: '#EF4444' }}>Order Cancelled</p>
          <p style={{ fontSize: 12, color: '#EF4444' }}>Contact the seller if you have questions.</p>
        </div>
      </div>
    );
  }
  const steps: { key: Order['status']; label: string; Icon: any }[] = [
    { key: 'Pending', label: 'Order Placed', Icon: Clock },
    { key: 'Processing', label: 'Processing', Icon: Package },
    { key: 'Completed', label: 'Completed', Icon: CheckCircle2 },
  ];
  const activeIndex = steps.findIndex(s => s.key === status);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      {steps.map((step, i) => (
        <div key={step.key} style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', position: 'relative' as const }}>
          {i > 0 && (
            <div style={{ position: 'absolute' as const, top: 16, right: '50%', width: '100%', height: 2, background: i <= activeIndex ? theme.primary : '#E5E7EB', zIndex: 0 }} />
          )}
          <div style={{ width: 34, height: 34, borderRadius: '50%', background: i <= activeIndex ? theme.primary : '#E5E7EB', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1, marginBottom: 8 }}>
            <step.Icon size={16} color={i <= activeIndex ? '#fff' : '#9CA3AF'} />
          </div>
          <p style={{ fontSize: 10.5, fontWeight: 700, color: i <= activeIndex ? '#111827' : '#9CA3AF', textAlign: 'center' as const }}>{step.label}</p>
        </div>
      ))}
    </div>
  );
}

function OrderStatusDetails({ order, merchant, theme }: { order: Order; merchant: MerchantInfo; theme: StoreTheme }) {
  return (
    <div>
      <div style={{ background: '#F9FAFB', borderRadius: 16, padding: 20, marginBottom: 20 }}>
        <OrderStatusStepper status={order.status} theme={theme} />
      </div>

      {order.deliveryAddress && (
        <div style={{ background: `${theme.primary}0d`, borderRadius: 14, padding: 14, marginBottom: 20 }}>
          <p style={{ fontSize: 11, fontWeight: 800, color: theme.primary, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}><MapPin size={13} /> Delivering to</p>
          <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.5 }}>{order.deliveryAddress}</p>
          <p style={{ fontSize: 12.5, color: '#6B7280', marginTop: 2 }}>{order.deliveryCity}, {order.deliveryState}</p>
        </div>
      )}

      {order.customFields && order.customFields.length > 0 && (
        <div style={{ background: '#F9FAFB', borderRadius: 14, padding: 14, marginBottom: 20 }}>
          {order.customFields.map((f, i) => (
            <div key={i} style={{ marginBottom: i < order.customFields!.length - 1 ? 8 : 0 }}>
              <p style={{ fontSize: 11, color: '#9CA3AF' }}>{f.label}</p>
              <p style={{ fontSize: 13, color: '#111827', fontWeight: 600 }}>{f.value}</p>
            </div>
          ))}
        </div>
      )}

      <div style={{ border: '1px solid #E5E7EB', borderRadius: 14, overflow: 'hidden', marginBottom: 20 }}>
        {order.items?.map((item, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 14px', borderBottom: i < order.items.length - 1 ? '1px solid #F3F4F6' : 'none' }}>
            <p style={{ fontSize: 13, color: '#374151' }}>{item.name} x{item.quantity}</p>
            <p style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{NAIRA}{(item.price * item.quantity).toLocaleString()}</p>
          </div>
        ))}
      </div>

      {order.shippingFee > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 4px', marginBottom: 8 }}>
          <span style={{ fontSize: 12.5, color: '#6B7280' }}>Delivery to {order.deliveryState}</span>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: '#374151' }}>{NAIRA}{order.shippingFee.toLocaleString()}</span>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 4px', marginBottom: 20 }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: '#111827' }}>Total</span>
        <span style={{ fontSize: 15, fontWeight: 800, color: theme.primary }}>{NAIRA}{order.total.toLocaleString()}</span>
      </div>

      {merchant.contactWhatsapp && (
        <a href={`https://wa.me/${merchant.contactWhatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(`Hi, I have a question about my order (Ref: ${order.reference})`)}`} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: '#fff', border: `1.5px solid ${theme.primary}`, color: theme.primary, borderRadius: 13, padding: 13, fontSize: 13.5, fontWeight: 700, textDecoration: 'none' }}>
          <MessageCircle size={15} /> Message Seller About This Order
        </a>
      )}
    </div>
  );
}

export function OrderLinkScreen() {
  const { slug, reference, token } = useParams();
  usePremiumFont();
  const { merchant, loading, notFound } = useMerchantBySlug(slug);
  useTrackingScripts(merchant);
  const [order, setOrder] = useState<Order | null>(null);
  const [checking, setChecking] = useState(true);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    if (!merchant?.uid || !reference) return;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'merchants', merchant.uid, 'orders', reference));
        if (!snap.exists() || snap.data().accessToken !== token) { setInvalid(true); setChecking(false); return; }
        setOrder(snap.data() as Order);
      } catch {
        setInvalid(true);
      } finally {
        setChecking(false);
      }
    })();
  }, [merchant?.uid, reference, token]);

  if (loading || checking) return <LoadingSpinner />;
  if (notFound || !merchant) return <StoreNotFound />;
  const theme = getTheme(merchant.themeId);

  if (invalid || !order) {
    return (
      <div style={{ minHeight: '100vh', background: theme.background, fontFamily: 'Inter, sans-serif' }}>
        <DarkHeader theme={theme} merchant={merchant} slug={slug!} backHref={`/${slug}`} showBack />
        <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', padding: 40, textAlign: 'center' as const }}>
          <AlertCircle size={28} color="#9CA3AF" style={{ marginBottom: 10 }} />
          <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 6 }}>Link not found</p>
          <p style={{ fontSize: 13, color: '#6B7280', marginBottom: 20 }}>This order link is invalid or the order no longer exists.</p>
          <Link to={`/${slug}/track`} style={{ color: theme.primary, fontSize: 13, fontWeight: 700, textDecoration: 'none' }}>Look Up My Order Instead</Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: theme.background, fontFamily: 'Inter, sans-serif', paddingBottom: 40 }}>
      <style>{`* { box-sizing: border-box; }`}</style>
      <DarkHeader theme={theme} merchant={merchant} slug={slug!} backHref={`/${slug}`} showBack />
      <div style={{ padding: '20px 20px 0' }}>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 21, fontWeight: 800, color: '#111827', marginBottom: 4 }}>Your Order</h1>
        <p style={{ fontSize: 12, color: '#9CA3AF', marginBottom: 22 }}>Ref: {order.reference}</p>
        <OrderStatusDetails order={order} merchant={merchant} theme={theme} />
      </div>
    </div>
  );
}

export function TrackOrderScreen() {
  const { slug } = useParams();
  usePremiumFont();
  const { merchant, loading, notFound } = useMerchantBySlug(slug);
  useTrackingScripts(merchant);
  const [reference, setReference] = useState('');
  const [email, setEmail] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [foundOrder, setFoundOrder] = useState<Order | null>(null);

  if (loading) return <LoadingSpinner />;
  if (notFound || !merchant) return <StoreNotFound />;
  const theme = getTheme(merchant.themeId);

  const handleSearch = async () => {
    setSearchError('');
    setFoundOrder(null);
    if (!reference.trim() || !email.trim()) { setSearchError('Please enter both your order reference and email.'); return; }
    setSearching(true);
    try {
      const snap = await getDoc(doc(db, 'merchants', merchant.uid, 'orders', reference.trim()));
      if (!snap.exists()) { setSearchError("We couldn't find an order with that reference and email."); return; }
      const data = snap.data() as Order;
      if ((data.customerEmail || '').toLowerCase() !== email.trim().toLowerCase()) {
        setSearchError("We couldn't find an order with that reference and email.");
        return;
      }
      setFoundOrder(data);
    } catch (err) {
      console.error('Order lookup failed:', err);
      setSearchError('Something went wrong. Please check your connection and try again.');
    } finally {
      setSearching(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: theme.background, fontFamily: 'Inter, sans-serif', paddingBottom: 40, overflowX: 'hidden' as const }}>
      <style>{`* { box-sizing: border-box; }`}</style>
      <DarkHeader theme={theme} merchant={merchant} slug={slug!} backHref={`/${slug}`} showBack />

      <div style={{ padding: '20px 20px 0' }}>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 21, fontWeight: 800, color: '#111827', marginBottom: 6 }}>Track Your Order</h1>
        <p style={{ fontSize: 13, color: '#6B7280', marginBottom: 22 }}>Enter your order reference and the email you used at checkout.</p>

        <input
          style={{ width: '100%', padding: '13px 15px', borderRadius: 12, border: '1px solid #E5E7EB', fontSize: 13.5, outline: 'none', marginBottom: 10, boxSizing: 'border-box' as const }}
          placeholder="Order reference (e.g. SP1234567890)"
          value={reference}
          onChange={e => setReference(e.target.value)}
        />
        <input
          style={{ width: '100%', padding: '13px 15px', borderRadius: 12, border: '1px solid #E5E7EB', fontSize: 13.5, outline: 'none', marginBottom: 14, boxSizing: 'border-box' as const }}
          placeholder="Email used at checkout"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
        />
        {searchError && <p style={{ color: '#EF4444', fontSize: 12.5, marginBottom: 14 }}>{searchError}</p>}

        <button
          onClick={handleSearch}
          disabled={searching}
          style={{ width: '100%', background: theme.primary, color: '#fff', border: 'none', borderRadius: 14, padding: 15, fontSize: 14, fontWeight: 800, cursor: 'pointer', opacity: searching ? 0.7 : 1, marginBottom: 26 }}
        >
          {searching ? 'Searching...' : 'Track Order'}
        </button>

        {foundOrder && <OrderStatusDetails order={foundOrder} merchant={merchant} theme={theme} />}
      </div>
    </div>
  );
}

export function StorefrontScreen() {
  const { slug } = useParams();
  usePremiumFont();
  const { merchant, loading, notFound } = useMerchantBySlug(slug);
  useTrackingScripts(merchant);
  useTrafficTracking(merchant?.uid, slug);
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const PRODUCTS_PER_PAGE = 10;
  const [currentPage, setCurrentPage] = useState(1);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  useEffect(() => {
    setCurrentPage(1);
  }, [activeCategory, search]);
  const [showWishlist, setShowWishlist] = useState(false);
  const wishlistIds = useWishlist(slug);
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [openBundle, setOpenBundle] = useState<Bundle | null>(null);
  const [bundleAdded, setBundleAdded] = useState(false);
  const scrollRestoredRef = useRef(false);

  // Remember where the customer scrolled to, so tapping "back" from a product returns them
  // to the same spot instead of dumping them at the top of a long page. Throttled to at most
  // once every 250ms instead of on every single scroll event, which was causing real,
  // visible lag the more someone scrolled, since storage writes are relatively expensive.
  useEffect(() => {
    if (!slug) return;
    let lastWrite = 0;
    let pendingTimeout: any = null;
    const write = () => {
      lastWrite = Date.now();
      try { sessionStorage.setItem(`sp_scroll_${slug}`, String(window.scrollY)); } catch {}
    };
    const handleScroll = () => {
      const now = Date.now();
      if (now - lastWrite >= 250) {
        write();
      } else if (!pendingTimeout) {
        pendingTimeout = setTimeout(() => { pendingTimeout = null; write(); }, 250 - (now - lastWrite));
      }
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => { window.removeEventListener('scroll', handleScroll); if (pendingTimeout) clearTimeout(pendingTimeout); };
  }, [slug]);

  useEffect(() => {
    if (loading || scrollRestoredRef.current || !slug) return;
    let saved: string | null = null;
    try { saved = sessionStorage.getItem(`sp_scroll_${slug}`); } catch {}
    if (saved) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => window.scrollTo(0, Number(saved)));
      });
    }
    scrollRestoredRef.current = true;
  }, [loading, slug]);

  useEffect(() => {
    if (!merchant?.uid) return;
    const unsub = onSnapshot(collection(db, 'merchants', merchant.uid, 'products'), (snap) => {
      const list: Product[] = snap.docs
        .map(d => ({ id: d.id, ...(d.data() as any) }))
        .filter((p: any) => !p._deleted && p.status !== 'Out of stock');
      setProducts(list);
    });
    return unsub;
  }, [merchant?.uid]);

  useEffect(() => {
    if (!merchant?.uid) return;
    const unsub = onSnapshot(collection(db, 'merchants', merchant.uid, 'bundles'), (snap) => {
      const list: Bundle[] = snap.docs
        .map(d => ({ id: d.id, ...(d.data() as any) }))
        .filter((b: any) => !b._deleted && b.active);
      setBundles(list);
    });
    return unsub;
  }, [merchant?.uid]);

  if (loading) return <LoadingSpinner />;
  if (notFound || !merchant) return <StoreNotFound />;

  const theme = getTheme(merchant.themeId);
  const categories = Array.from(new Set(products.map(p => p.category).filter(Boolean))) as string[];
  const newArrivals = products.filter(p => p.badge === 'New');

  const filtered = products.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) &&
    (!activeCategory || p.category === activeCategory)
  );

  const goToCategory = (cat: string) => {
    setActiveCategory(cat);
    setShowWishlist(false);
    setTimeout(() => document.getElementById('sp-products')?.scrollIntoView({ behavior: 'smooth' }), 50);
  };


  const wishedProducts = products.filter(p => wishlistIds.includes(p.id));

  return (
    <div style={{ minHeight: '100vh', background: theme.background, fontFamily: 'Inter, sans-serif', transition: 'background 0.5s ease', overflowX: 'hidden' as const, width: '100%', maxWidth: '100vw', boxSizing: 'border-box' as const }}>
      <style>{`
        * { box-sizing: border-box; }
        html, body { overflow-x: hidden; max-width: 100vw; }
        .sp-card:active { transform: scale(0.97); box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        .sp-chip { transition: background 0.3s ease, color 0.3s ease, border-color 0.3s ease; }
        .sp-btn:active { transform: scale(0.96); }
      `}</style>

      {merchant.announcementBanner && (
        <div style={{ background: theme.accent, color: theme.secondary, textAlign: 'center' as const, fontSize: 11.5, fontWeight: 800, padding: '8px 16px', letterSpacing: 0.2 }}>
          {merchant.announcementBanner}
        </div>
      )}

      <SaleCountdownBanner merchant={merchant} theme={theme} />

      <DarkHeader theme={theme} merchant={merchant} slug={slug!} onWishlistClick={() => setShowWishlist(w => !w)} wishlistActive={showWishlist} onSearchClick={() => setSearchOpen(o => !o)} searchActive={searchOpen} />

      {showWishlist && (
        <div style={{ padding: 16 }}>
          <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 19, fontWeight: 700, color: '#111827', marginBottom: 14 }}>Your Wishlist</h3>
          {wishedProducts.length === 0 ? (
            <div style={{ textAlign: 'center' as const, padding: '50px 0', color: '#6B7280' }}>
              <Heart size={32} color="#D1D5DB" style={{ marginBottom: 12 }} />
              <p style={{ fontSize: 14 }}>Nothing saved yet. Tap the heart on any product to add it here.</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14, alignItems: 'stretch' as const }}>
              {wishedProducts.map(product => <ProductCard key={product.id} product={product} theme={theme} slug={slug!} wishlistIds={wishlistIds} />)}
            </div>
          )}
        </div>
      )}

      {!showWishlist && (
        <>
          {searchOpen && (
            <div style={{ background: theme.secondary, padding: '0 16px 14px', transition: 'background 0.5s ease' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(255,255,255,0.1)', borderRadius: 12, padding: '9px 14px' }}>
                <Search size={15} color="rgba(255,255,255,0.7)" />
                <input
                  autoFocus
                  style={{ background: 'transparent', border: 'none', outline: 'none', fontSize: 13.5, color: '#fff', flex: 1, minWidth: 0 }}
                  placeholder="Search products..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                {search && (
                  <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.7)', display: 'flex' }}>
                    <X size={15} />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Hero - wide banner, either a merchant-uploaded cover photo or the default gradient background */}
          <div style={{
            margin: '16px', borderRadius: 20, overflow: 'hidden', position: 'relative' as const,
            background: merchant.coverImageUrl ? '#111' : `linear-gradient(120deg, ${theme.primary}, ${theme.secondary})`,
            padding: '22px 22px', minHeight: 132, display: 'flex', flexDirection: 'column' as const, justifyContent: 'center',
          }}>
            {merchant.coverImageUrl && (
              <img src={getOptimizedImageUrl(merchant.coverImageUrl, 800)} alt={merchant.storeName} style={{ position: 'absolute' as const, inset: 0, width: '100%', height: '100%', objectFit: 'cover' as const }} />
            )}
            {merchant.coverImageUrl ? (
              <div style={{ position: 'absolute' as const, inset: 0, background: 'linear-gradient(0deg, rgba(0,0,0,0.55), rgba(0,0,0,0.15))' }} />
            ) : (
              <>
                <div style={{ position: 'absolute' as const, width: 130, height: 130, borderRadius: '50%', background: 'rgba(255,255,255,0.07)', filter: 'blur(2px)', top: -40, right: -30 }} />
                <div style={{ position: 'absolute' as const, width: 90, height: 90, borderRadius: '50%', background: 'rgba(255,255,255,0.05)', filter: 'blur(1px)', bottom: -30, left: -10 }} />
              </>
            )}
            <div style={{ position: 'relative' as const, zIndex: 1 }}>
              <p style={{ color: 'rgba(255,255,255,0.8)', fontSize: 10, fontWeight: 800, letterSpacing: 1.5, textTransform: 'uppercase' as const, marginBottom: 6 }}>Welcome to</p>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' as const }}>
                <div style={{ minWidth: 0 }}>
                  <h2 style={{ fontFamily: "'Playfair Display', serif", color: '#fff', fontSize: 24, fontWeight: 800, marginBottom: 4, lineHeight: 1.1 }}>{merchant.storeName || 'Our Store'}</h2>
                  {merchant.storeDescription && (
                    <p style={{
                      color: 'rgba(255,255,255,0.85)', fontSize: 12, lineHeight: 1.4, maxWidth: 220,
                      display: '-webkit-box' as const, WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden', textOverflow: 'ellipsis' as const,
                    }}>{merchant.storeDescription}</p>
                  )}
                </div>
                <a href="#sp-products" className="sp-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: theme.accent, color: theme.secondary, border: 'none', borderRadius: 12, padding: '11px 18px', fontWeight: 800, fontSize: 12.5, cursor: 'pointer', boxShadow: '0 8px 18px rgba(0,0,0,0.2)', textDecoration: 'none', transition: 'transform 0.15s ease', flexShrink: 0, whiteSpace: 'nowrap' as const }}>
                  Shop Now <ArrowRight size={14} />
                </a>
              </div>
            </div>
          </div>

          {/* Product Bundles */}
          {bundles.length > 0 && (
            <div style={{ padding: '0 16px 24px' }}>
              <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 700, color: '#111827', marginBottom: 12 }}>Bundle & Save</h3>
              <div style={{ display: 'flex', gap: 12, overflowX: 'auto' as const, paddingBottom: 4 }}>
                {bundles.map(bundle => {
                  const bundleProducts = products.filter(p => bundle.productIds.includes(p.id));
                  if (bundleProducts.length < 2) return null;
                  const originalTotal = bundleProducts.reduce((sum, p) => sum + (p.salePrice || p.price), 0);
                  return (
                    <button key={bundle.id} onClick={() => setOpenBundle(bundle)} className="sp-btn" style={{ flexShrink: 0, width: 168, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 16, padding: 12, textAlign: 'left' as const, cursor: 'pointer' }}>
                      <div style={{ display: 'flex', marginBottom: 10 }}>
                        {bundleProducts.slice(0, 3).map((p, i) => (
                          <div key={p.id} style={{ width: 44, height: 44, borderRadius: 10, overflow: 'hidden', border: '2px solid #fff', marginLeft: i > 0 ? -14 : 0, background: '#F3F4F6', flexShrink: 0 }}>
                            {(p.images?.[0] || p.imageUrl) ? <img src={getOptimizedImageUrl(p.images?.[0] || p.imageUrl, 100)} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover' as const }} loading="lazy" /> : <ProductIcon iconKey={p.emoji} size={20} color={theme.primary} />}
                          </div>
                        ))}
                      </div>
                      <p style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>{bundle.name}</p>
                      <p style={{ fontSize: 11, color: '#9CA3AF', marginBottom: 6 }}>{bundleProducts.length} items</p>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        {originalTotal > bundle.bundlePrice && <span style={{ fontSize: 11, color: '#9CA3AF', textDecoration: 'line-through' as const }}>{NAIRA}{originalTotal.toLocaleString()}</span>}
                        <span style={{ fontSize: 14, fontWeight: 800, color: theme.primary }}>{NAIRA}{bundle.bundlePrice.toLocaleString()}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Featured Collections - built from real categories */}
          {categories.length > 0 && (
            <div style={{ padding: '0 16px 24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 700, color: '#111827' }}>Featured Collections</h3>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12 }}>
                {categories.map(cat => {
                  const inCat = products.filter(p => p.category === cat);
                  const rep = inCat.find(p => p.imageUrl) || inCat[0];
                  const Icon = CATEGORY_ICONS[cat] || Tag;
                  return (
                    <button key={cat} onClick={() => goToCategory(cat)} className="sp-card" style={{ position: 'relative' as const, borderRadius: 18, overflow: 'hidden', border: 'none', cursor: 'pointer', aspectRatio: '0.95', background: `linear-gradient(135deg, ${theme.primary}22, ${theme.secondary}22)`, padding: 0, transition: 'transform 0.15s ease' }}>
                      {rep?.imageUrl ? (
                        <img src={getOptimizedImageUrl(rep.imageUrl, 200)} alt={cat} style={{ width: '100%', height: '100%', objectFit: 'cover' as const, position: 'absolute' as const, inset: 0 }} loading="lazy" />
                      ) : (
                        <div style={{ position: 'absolute' as const, inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <Icon size={36} color={theme.primary} />
                        </div>
                      )}
                      <div style={{ position: 'absolute' as const, inset: 0, background: 'linear-gradient(to top, rgba(0,0,0,0.65), transparent 60%)' }} />
                      <div style={{ position: 'absolute' as const, bottom: 12, left: 12, right: 12, textAlign: 'left' as const }}>
                        <p style={{ color: '#fff', fontSize: 13, fontWeight: 800 }}>{cat}</p>
                        <p style={{ color: 'rgba(255,255,255,0.8)', fontSize: 10.5 }}>{inCat.length} item{inCat.length !== 1 ? 's' : ''}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Product grid */}
          <div id="sp-products" style={{ padding: '4px 16px 16px' }}>
            <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 700, color: '#111827', marginBottom: 14 }}>
              {activeCategory || (search ? 'Search results' : 'Best Sellers')}
            </h3>
            {filtered.length === 0 && (
              <div style={{ textAlign: 'center' as const, padding: '50px 0', color: '#6B7280' }}>
                <ShoppingBag size={32} color="#D1D5DB" style={{ marginBottom: 12 }} />
                <p style={{ fontSize: 14 }}>{products.length === 0 ? 'No products available yet.' : 'No products match here.'}</p>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14, alignItems: 'stretch' as const }}>
              {filtered.slice((currentPage - 1) * PRODUCTS_PER_PAGE, currentPage * PRODUCTS_PER_PAGE).map(product => <ProductCard key={product.id} product={product} theme={theme} slug={slug!} wishlistIds={wishlistIds} />)}
            </div>
            {filtered.length > PRODUCTS_PER_PAGE && (() => {
              const totalPages = Math.ceil(filtered.length / PRODUCTS_PER_PAGE);
              const goToPage = (p: number) => {
                setCurrentPage(p);
                document.getElementById('sp-products')?.scrollIntoView({ behavior: 'smooth' });
              };
              return (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 22, flexWrap: 'wrap' as const }}>
                  <button
                    onClick={() => goToPage(Math.max(1, currentPage - 1))}
                    disabled={currentPage === 1}
                    style={{ width: 34, height: 34, borderRadius: '50%', border: 'none', background: '#F3F4F6', color: '#374151', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: currentPage === 1 ? 'default' : 'pointer', opacity: currentPage === 1 ? 0.4 : 1 }}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  {getPageNumbers(currentPage, totalPages).map((p, i) => p === '...' ? (
                    <span key={`e${i}`} style={{ width: 28, textAlign: 'center' as const, color: '#9CA3AF', fontSize: 13 }}>...</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => goToPage(p)}
                      style={{
                        width: 34, height: 34, borderRadius: '50%', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                        background: p === currentPage ? theme.primary : '#F3F4F6',
                        color: p === currentPage ? '#fff' : '#374151',
                      }}
                    >
                      {p}
                    </button>
                  ))}
                  <button
                    onClick={() => goToPage(Math.min(totalPages, currentPage + 1))}
                    disabled={currentPage === totalPages}
                    style={{ width: 34, height: 34, borderRadius: '50%', border: 'none', background: '#F3F4F6', color: '#374151', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: currentPage === totalPages ? 'default' : 'pointer', opacity: currentPage === totalPages ? 0.4 : 1 }}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              );
            })()}
          </div>

          {/* TEMPORARILY REMOVED for a performance test - "Discover More with [Store]" banner and
              "New Arrivals" row used to be here. Ask Claude to bring these back once the test is done. */}
        </>
      )}

      {!showWishlist && <StoreFooter merchant={merchant} theme={theme} slug={slug!} />}
      <FloatingWhatsApp merchant={merchant} theme={theme} />

      {openBundle && (() => {
        const bundleProducts = products.filter(p => openBundle.productIds.includes(p.id));
        const originalTotal = bundleProducts.reduce((sum, p) => sum + (p.salePrice || p.price), 0);
        return (
          <div onClick={() => { setOpenBundle(null); setBundleAdded(false); }} style={{ position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'flex-end' }}>
            <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: '24px 24px 0 0', padding: 20, width: '100%', maxHeight: '80vh', overflowY: 'auto' as const }}>
              <div style={{ width: 36, height: 4, background: '#E5E7EB', borderRadius: 2, margin: '0 auto 16px' }} />
              <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 19, fontWeight: 800, color: '#111827', marginBottom: 4 }}>{openBundle.name}</h3>
              <p style={{ fontSize: 12.5, color: '#9CA3AF', marginBottom: 16 }}>{bundleProducts.length} items included</p>

              <div style={{ border: '1px solid #E5E7EB', borderRadius: 14, overflow: 'hidden', marginBottom: 16 }}>
                {bundleProducts.map((p, i) => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: i < bundleProducts.length - 1 ? '1px solid #F3F4F6' : 'none' }}>
                    <div style={{ width: 40, height: 40, borderRadius: 8, overflow: 'hidden', background: '#F3F4F6', flexShrink: 0 }}>
                      {(p.images?.[0] || p.imageUrl) ? <img src={getOptimizedImageUrl(p.images?.[0] || p.imageUrl, 250)} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover' as const }} loading="lazy" /> : <ProductIcon iconKey={p.emoji} size={18} color={theme.primary} />}
                    </div>
                    <p style={{ fontSize: 13, color: '#374151', flex: 1 }}>{p.name}</p>
                    <p style={{ fontSize: 12.5, color: '#9CA3AF', textDecoration: 'line-through' as const }}>{NAIRA}{(p.salePrice || p.price).toLocaleString()}</p>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#F9FAFB', borderRadius: 12, padding: '12px 16px', marginBottom: 18 }}>
                <div>
                  <p style={{ fontSize: 11.5, color: '#9CA3AF' }}>Buying separately</p>
                  <p style={{ fontSize: 13, color: '#9CA3AF', textDecoration: 'line-through' as const }}>{NAIRA}{originalTotal.toLocaleString()}</p>
                </div>
                <div style={{ textAlign: 'right' as const }}>
                  <p style={{ fontSize: 11.5, color: theme.primary, fontWeight: 700 }}>Bundle price</p>
                  <p style={{ fontSize: 20, fontWeight: 800, color: theme.primary }}>{NAIRA}{openBundle.bundlePrice.toLocaleString()}</p>
                </div>
              </div>

              <button
                onClick={() => { addBundleToCart(slug!, openBundle, bundleProducts); setBundleAdded(true); setTimeout(() => { setOpenBundle(null); setBundleAdded(false); }, 1200); }}
                style={{ width: '100%', background: theme.primary, color: '#fff', border: 'none', borderRadius: 14, padding: 16, fontSize: 15, fontWeight: 800, cursor: 'pointer' }}
              >
                {bundleAdded ? 'Added to Cart!' : `Add Bundle to Cart - ${NAIRA}${openBundle.bundlePrice.toLocaleString()}`}
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export function ProductDetailScreen() {
  const { slug, productId } = useParams();
  const navigate = useNavigate();
  usePremiumFont();
  const { merchant, loading: merchantLoading, notFound } = useMerchantBySlug(slug);
  useTrackingScripts(merchant);
  const [product, setProduct] = useState<Product | null>(null);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [loadingProduct, setLoadingProduct] = useState(true);
  const [selectedOptions, setSelectedOptions] = useState<{ [group: string]: string }>({});
  const [openSection, setOpenSection] = useState<number | null>(0);
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);
  const [activeImage, setActiveImage] = useState(0);
  const galleryRef = useRef<HTMLDivElement>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [reviewName, setReviewName] = useState('');
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewComment, setReviewComment] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [reviewSubmitted, setReviewSubmitted] = useState(false);

  useEffect(() => {
    if (!merchant?.uid || !productId) return;
    const unsub = onSnapshot(collection(db, 'merchants', merchant.uid, 'products'), (snap) => {
      const list: Product[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })).filter((p: any) => !p._deleted);
      const found = list.find(p => p.id === productId);
      setProduct(found || null);
      setAllProducts(list.filter(p => p.id !== productId && p.status !== 'Out of stock'));
      setLoadingProduct(false);
    }, () => setLoadingProduct(false));
    return unsub;
  }, [merchant?.uid, productId]);

  useEffect(() => {
    if (!product) return;
    trackStoreEvent('ViewContent', { value: product.salePrice || product.price, currency: 'NGN', content_name: product.name });
  }, [product?.id]);

  // Reset quantity to this product's minimum whenever the customer navigates to a different product
  useEffect(() => {
    if (product?.minOrderQty) setQuantity(product.minOrderQty);
    else setQuantity(1);
  }, [product?.id]);

  useEffect(() => {
    if (!merchant?.uid || !productId) return;
    const q = query(collection(db, 'merchants', merchant.uid, 'reviews'), where('productId', '==', productId));
    const unsub = onSnapshot(q, (snap) => {
      const list: Review[] = snap.docs
        .map(d => ({ id: d.id, ...(d.data() as any) }))
        .sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      setReviews(list);
    });
    return unsub;
  }, [merchant?.uid, productId]);

  if (merchantLoading || loadingProduct) return <LoadingSpinner />;
  if (notFound || !merchant) return <StoreNotFound />;
  if (!product) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' as const, fontFamily: 'Inter, sans-serif' }}>
        <p style={{ fontSize: 15, color: '#6B7280', marginBottom: 16 }}>This product isn't available anymore.</p>
        <Link to={`/${slug}`} style={{ color: '#142A45', fontWeight: 700, fontSize: 14, textDecoration: 'none' }}>Back to store</Link>
      </div>
    );
  }

  const theme = getTheme(merchant.themeId);
  const discount = product.salePrice ? Math.round((1 - product.salePrice / product.price) * 100) : 0;

  const handleAddToCart = () => {
    addToCart(slug!, product, quantity, Object.keys(selectedOptions).length ? selectedOptions : undefined);
    trackStoreEvent('AddToCart', { value: (product.salePrice || product.price) * quantity, currency: 'NGN', content_name: product.name });
    setAdded(true);
    setTimeout(() => setAdded(false), 1800);
  };

  const gallery = product.images && product.images.length > 0 ? product.images : (product.imageUrl ? [product.imageUrl] : []);

  const jumpToImage = (index: number) => {
    setActiveImage(index);
    if (galleryRef.current) {
      galleryRef.current.scrollTo({ left: index * galleryRef.current.clientWidth, behavior: 'smooth' });
    }
  };

  const related = allProducts.slice(0, 10);

  const handleSubmitReview = async () => {
    setReviewError('');
    if (reviewRating === 0) {
      setReviewError('Please choose a star rating.');
      return;
    }
    if (!reviewName.trim()) {
      setReviewError('Please enter your name.');
      return;
    }
    setSubmittingReview(true);
    try {
      const id = Date.now().toString();
      const review: Review = {
        id,
        productId: productId!,
        productName: product.name,
        customerName: reviewName.trim(),
        rating: reviewRating,
        comment: reviewComment.trim(),
        createdAt: new Date().toISOString(),
      };
      await setDoc(doc(db, 'merchants', merchant.uid, 'reviews', id), review);
      pushNotification(merchant.uid, `${review.customerName} left a ${review.rating}-star review on ${product.name}`, 'new-review');
      setReviewSubmitted(true);
      setShowReviewForm(false);
      setReviewName('');
      setReviewRating(0);
      setReviewComment('');
      setTimeout(() => setReviewSubmitted(false), 3000);
    } catch (err: any) {
      setReviewError(err?.message || 'Could not submit your review. Please try again.');
    } finally {
      setSubmittingReview(false);
    }
  };

  const avgRating = reviews.length > 0 ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;

  return (
    <div style={{ minHeight: '100vh', background: theme.background, fontFamily: 'Inter, sans-serif', paddingBottom: 40, transition: 'background 0.5s ease', overflowX: 'hidden' as const }}>
      <style>{`* { box-sizing: border-box; } .sp-btn:active { transform: scale(0.96); }`}</style>

      <SaleCountdownBanner merchant={merchant} theme={theme} />

      <DarkHeader theme={theme} merchant={merchant} slug={slug!} backHref={`/${slug}`} showBack />

      <div style={{ padding: '12px 16px 0' }}>
        <p style={{ fontSize: 11.5, color: '#9CA3AF', display: 'flex', alignItems: 'center', flexWrap: 'wrap' as const, gap: 2 }}>
          <Link to={`/${slug}`} style={{ color: '#9CA3AF', textDecoration: 'none' }}>Home</Link>
          {product.category && (
            <>
              <ChevronRight size={12} color="#9CA3AF" />
              <span style={{ color: '#6B7280' }}>{product.category}</span>
            </>
          )}
          <ChevronRight size={12} color="#9CA3AF" />
          <span style={{ color: '#111827', fontWeight: 600 }}>{product.name}</span>
        </p>
      </div>

      {/* 1. Product Gallery - larger main image, bolder thumbnails */}
      <div style={{ width: 'calc(100% - 32px)', aspectRatio: '0.82', background: `linear-gradient(135deg, ${theme.primary}12, ${theme.secondary}0a)`, borderRadius: 22, overflow: 'hidden', margin: '12px 16px', position: 'relative' as const }}>
        {gallery.length === 0 ? (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ProductIcon iconKey={product.emoji} size={80} color={theme.primary} />
          </div>
        ) : (
          <>
            <div
              ref={galleryRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                const idx = Math.round(el.scrollLeft / el.clientWidth);
                if (idx !== activeImage) setActiveImage(idx);
              }}
              style={{ display: 'flex', overflowX: 'auto' as const, scrollSnapType: 'x mandatory' as const, width: '100%', height: '100%', WebkitOverflowScrolling: 'touch' as const }}
            >
              {gallery.map((img, i) => (
                <div key={i} style={{ minWidth: '100%', height: '100%', scrollSnapAlign: 'start' as const, flexShrink: 0 }}>
                  <img src={getOptimizedImageUrl(img, 800)} alt={`${product.name} ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' as const }} loading="lazy" />
                </div>
              ))}
            </div>
            {gallery.length > 1 && (
              <div style={{ position: 'absolute' as const, bottom: 14, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 6 }}>
                {gallery.map((_, i) => (
                  <div key={i} style={{ width: i === activeImage ? 18 : 6, height: 6, borderRadius: 3, background: i === activeImage ? theme.primary : 'rgba(255,255,255,0.7)', boxShadow: '0 1px 3px rgba(0,0,0,0.3)', transition: 'width 0.2s ease' }} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {gallery.length > 1 && (
        <div style={{ display: 'flex', gap: 10, padding: '0 16px 6px', overflowX: 'auto' as const }}>
          {gallery.map((img, i) => (
            <button
              key={i}
              onClick={() => jumpToImage(i)}
              style={{
                width: 64, height: 64, borderRadius: 13, overflow: 'hidden', flexShrink: 0, padding: 0, cursor: 'pointer',
                border: `2.5px solid ${i === activeImage ? theme.primary : '#E5E7EB'}`, opacity: i === activeImage ? 1 : 0.75,
                transition: 'opacity 0.2s ease, border-color 0.2s ease',
              }}
            >
              <img src={getOptimizedImageUrl(img, 150)} alt={`Thumbnail ${i + 1}`} style={{ width: '100%', height: '100%', objectFit: 'cover' as const, display: 'block' }} loading="lazy" />
            </button>
          ))}
        </div>
      )}

      <div style={{ padding: '20px 20px 0' }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {product.badge !== 'None' && (
            <span style={{ background: theme.primary, color: '#fff', fontSize: 11, fontWeight: 800, padding: '5px 12px', borderRadius: 20 }}>{product.badge}</span>
          )}
          {discount > 0 && (
            <span style={{ background: '#FEE2E2', color: '#EF4444', fontSize: 11, fontWeight: 800, padding: '5px 12px', borderRadius: 20 }}>-{discount}% OFF</span>
          )}
        </div>

        {/* 2. Product Name - no price here, left aligned */}
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 24, fontWeight: 800, color: '#111827', marginBottom: 7, lineHeight: 1.2, textAlign: 'left' as const }}>{product.name}</h1>

        {/* 3. Star Rating - real data, left aligned */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 14, textAlign: 'left' as const }}>
          <div style={{ display: 'flex', gap: 2 }}>
            {[1, 2, 3, 4, 5].map(i => <Star key={i} size={16} color={i <= Math.round(avgRating) ? '#F59E0B' : '#D1D5DB'} fill={i <= Math.round(avgRating) ? '#F59E0B' : 'none'} />)}
          </div>
          <span style={{ fontSize: 13, color: '#6B7280', fontWeight: 600 }}>
            {reviews.length > 0 ? `${avgRating.toFixed(1)} (${reviews.length} Review${reviews.length !== 1 ? 's' : ''})` : 'No reviews yet'}
          </span>
        </div>

        {/* 4. Description - left aligned */}
        {product.descriptionSections && product.descriptionSections.length > 0 ? (
          <div style={{ marginBottom: 16, textAlign: 'left' as const }}>
            {product.descriptionSections.map((section, i) => (
              <div key={i} style={{ marginBottom: i < product.descriptionSections!.length - 1 ? 8 : 0 }}>
                <p style={{ fontSize: 13.5, fontWeight: 700, color: '#111827', marginBottom: 3 }}>{section.title}</p>
                <p style={{ fontSize: 13.5, color: '#6B7280', lineHeight: 1.6 }}>{section.text}</p>
              </div>
            ))}
          </div>
        ) : product.description ? (
          <p style={{ fontSize: 14, color: '#4B5563', lineHeight: 1.65, marginBottom: 16, textAlign: 'left' as const }}>{product.description}</p>
        ) : null}

        {/* 5. Price - bold, prominent, left aligned. Reflects wholesale tier pricing if set. */}
        {(() => {
          const basePrice = product.salePrice || product.price;
          const effectivePrice = getTieredPrice(basePrice, product.priceTiers, quantity);
          const onDiscountedTier = effectivePrice < basePrice;
          return (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: product.priceTiers?.length ? 10 : 20, textAlign: 'left' as const }}>
                <span style={{ fontSize: 29, fontWeight: 800, color: theme.primary }}>{NAIRA}{effectivePrice.toLocaleString()}</span>
                {(onDiscountedTier || product.salePrice) && (
                  <span style={{ fontSize: 16, color: '#9CA3AF', textDecoration: 'line-through' }}>{NAIRA}{(product.salePrice ? product.price : basePrice).toLocaleString()}</span>
                )}
                {onDiscountedTier && <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: theme.primary, padding: '3px 8px', borderRadius: 20 }}>each</span>}
              </div>
              {product.priceTiers && product.priceTiers.length > 0 && (
                <div style={{ border: '1px solid #E5E7EB', borderRadius: 12, overflow: 'hidden', marginBottom: 20 }}>
                  <div style={{ background: '#F9FAFB', padding: '7px 12px' }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: '#6B7280', textTransform: 'uppercase' as const, letterSpacing: 0.3 }}>Buy More, Save More</span>
                  </div>
                  {[{ minQty: 1, price: basePrice }, ...product.priceTiers].map((tier, i, arr) => {
                    const isActive = quantity >= tier.minQty && (i === arr.length - 1 || quantity < arr[i + 1].minQty);
                    return (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: isActive ? `${theme.primary}0d` : 'transparent', borderTop: i > 0 ? '1px solid #F3F4F6' : 'none' }}>
                        <span style={{ fontSize: 12.5, color: isActive ? theme.primary : '#374151', fontWeight: isActive ? 700 : 500 }}>{tier.minQty}+ units</span>
                        <span style={{ fontSize: 12.5, color: isActive ? theme.primary : '#374151', fontWeight: isActive ? 700 : 500 }}>{NAIRA}{tier.price.toLocaleString()} each</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          );
        })()}

        {/* 6 & 7. Color (large square swatches) and Size (rounded-square buttons) - left aligned */}
        {product.options && product.options.length > 0 && product.options.map(group => {
          const isColor = isColorOptionGroup(group.name);
          return (
            <div key={group.name} style={{ marginBottom: 18, textAlign: 'left' as const }}>
              <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 10, textAlign: 'left' as const }}>{group.name}{selectedOptions[group.name] ? `: ${selectedOptions[group.name]}` : ''}</p>
              {isColor ? (
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const, justifyContent: 'flex-start' as const }}>
                  {group.values.map(v => {
                    const isSelected = selectedOptions[group.name] === v;
                    const showSwatch = isValidCSSColor(v);
                    return (
                      <button
                        key={v}
                        className="sp-btn"
                        onClick={() => setSelectedOptions({ ...selectedOptions, [group.name]: v })}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 5, transition: 'transform 0.15s ease' }}
                      >
                        <div style={{
                          width: 48, height: 48, borderRadius: 13, background: showSwatch ? v : '#F3F4F6',
                          border: `2.5px solid ${isSelected ? theme.primary : '#E5E7EB'}`,
                          boxShadow: isSelected ? `0 0 0 2px ${theme.primary}22` : 'none',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          {!showSwatch && <span style={{ fontSize: 10, color: '#9CA3AF', fontWeight: 700, textAlign: 'center' as const, padding: 4 }}>{v.slice(0, 3)}</span>}
                        </div>
                        <span style={{ fontSize: 11, fontWeight: isSelected ? 700 : 500, color: isSelected ? '#111827' : '#6B7280' }}>{v}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' as const, justifyContent: 'flex-start' as const }}>
                  {group.values.map(v => {
                    const isSelected = selectedOptions[group.name] === v;
                    return (
                      <button
                        key={v}
                        className="sp-btn"
                        onClick={() => setSelectedOptions({ ...selectedOptions, [group.name]: v })}
                        style={{
                          padding: '11px 18px', borderRadius: 15, fontSize: 14, fontWeight: 700, cursor: 'pointer',
                          border: `2px solid ${isSelected ? theme.primary : '#E5E7EB'}`,
                          background: isSelected ? theme.primary : '#fff',
                          color: isSelected ? '#fff' : '#374151',
                          transition: 'transform 0.15s ease',
                        }}
                      >
                        {v}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* 8. Quantity - centered, as requested */}
        <div style={{ marginBottom: 20, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', textAlign: 'center' as const }}>
          <p style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 10 }}>Quantity</p>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 18, background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 14, padding: '8px 18px' }}>
            <button className="sp-btn" onClick={() => setQuantity(q => Math.max(product.minOrderQty || 1, q - 1))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#374151', display: 'flex' }}><Minus size={18} /></button>
            <span style={{ fontSize: 16, fontWeight: 700, color: '#111827', minWidth: 22, textAlign: 'center' as const }}>{quantity}</span>
            <button className="sp-btn" onClick={() => setQuantity(q => product.maxOrderQty ? Math.min(product.maxOrderQty, q + 1) : q + 1)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#374151', display: 'flex' }}><Plus size={18} /></button>
          </div>
          {(product.minOrderQty || product.maxOrderQty) && (
            <p style={{ fontSize: 11.5, color: '#9CA3AF', marginTop: 8 }}>
              {product.minOrderQty && product.maxOrderQty
                ? `Order between ${product.minOrderQty} and ${product.maxOrderQty} per order`
                : product.minOrderQty
                ? `Minimum order: ${product.minOrderQty}`
                : `Maximum per order: ${product.maxOrderQty}`}
            </p>
          )}
        </div>

        {/* 9. Add to Cart - wide outline */}
        <button
          className="sp-btn"
          onClick={handleAddToCart}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, background: '#fff', color: theme.primary, border: `2px solid ${theme.primary}`, borderRadius: 16, padding: 16, fontSize: 15, fontWeight: 800, cursor: 'pointer', marginBottom: 10, transition: 'transform 0.15s ease' }}
        >
          <ShoppingCart size={18} /> {added ? <><CheckCircle2 size={16} /> Added</> : 'Add to Cart'}
        </button>

        {/* 10. Buy Now - full width solid, no lightning icon */}
        <button
          className="sp-btn"
          onClick={() => { handleAddToCart(); navigate(`/${slug}/checkout`); }}
          style={{ width: '100%', background: theme.primary, color: '#fff', border: 'none', borderRadius: 16, padding: 16, fontSize: 15, fontWeight: 800, cursor: 'pointer', marginBottom: 26, transition: 'transform 0.15s ease' }}
        >
          Buy Now
        </button>

        {/* 11. Benefits Section */}
        <div style={{ marginBottom: 26 }}>
          <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 700, color: '#111827', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 7, textAlign: 'left' as const }}>
            Why Customers Choose Us <Star size={16} color="#F59E0B" fill="#F59E0B" />
          </h3>
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { Icon: ShieldCheck, label: 'Original Products' },
              { Icon: Truck, label: 'Fast Delivery' },
              { Icon: Lock, label: 'Secure Payments' },
              { Icon: RotateCcw, label: 'Easy Returns' },
            ].map(t => (
              <div key={t.label} style={{ flex: 1, textAlign: 'center' as const, background: '#F9FAFB', borderRadius: 14, padding: '16px 6px' }}>
                <t.Icon size={20} color={theme.primary} style={{ marginBottom: 7 }} />
                <p style={{ fontSize: 9.5, color: '#4B5563', fontWeight: 700, lineHeight: 1.25 }}>{t.label}</p>
              </div>
            ))}
          </div>
        </div>

        {/* 12. Customer Reviews */}
        <div style={{ marginBottom: 26 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, fontWeight: 700, color: '#111827', display: 'flex', alignItems: 'center', gap: 7, textAlign: 'left' as const }}>
              Customer Reviews <Star size={16} color="#F59E0B" fill="#F59E0B" />
            </h3>
            {!showReviewForm && (
              <button onClick={() => setShowReviewForm(true)} className="sp-btn" style={{ background: 'none', border: 'none', color: theme.primary, fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' as const }}>
                Write a Review
              </button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 2 }}>
              {[1, 2, 3, 4, 5].map(i => <Star key={i} size={15} color={i <= Math.round(avgRating) ? '#F59E0B' : '#D1D5DB'} fill={i <= Math.round(avgRating) ? '#F59E0B' : 'none'} />)}
            </div>
            {reviews.length > 0 ? (
              <span style={{ fontSize: 12.5, color: '#6B7280', fontWeight: 600 }}>{avgRating.toFixed(1)} ({reviews.length} Review{reviews.length !== 1 ? 's' : ''})</span>
            ) : (
              <span style={{ fontSize: 12.5, color: '#9CA3AF' }}>No reviews yet</span>
            )}
          </div>

          {reviewSubmitted && (
            <div style={{ background: '#DCFCE7', color: '#16A34A', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, fontWeight: 600, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
              <CheckCircle2 size={14} /> Thanks for your review!
            </div>
          )}

          {showReviewForm && (
            <div style={{ background: '#F9FAFB', borderRadius: 14, padding: 16, marginBottom: reviews.length > 0 ? 16 : 0 }}>
              <p style={{ fontSize: 12.5, fontWeight: 700, color: '#111827', marginBottom: 9 }}>Your rating</p>
              <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                {[1, 2, 3, 4, 5].map(i => (
                  <button key={i} onClick={() => setReviewRating(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}>
                    <Star size={28} color={i <= reviewRating ? '#F59E0B' : '#D1D5DB'} fill={i <= reviewRating ? '#F59E0B' : 'none'} />
                  </button>
                ))}
              </div>
              <input
                style={{ width: '100%', padding: '11px 14px', borderRadius: 11, border: '1px solid #E5E7EB', fontSize: 13.5, outline: 'none', marginBottom: 9, boxSizing: 'border-box' as const }}
                placeholder="Your name"
                value={reviewName}
                onChange={e => setReviewName(e.target.value)}
                maxLength={60}
              />
              <textarea
                style={{ width: '100%', padding: '11px 14px', borderRadius: 11, border: '1px solid #E5E7EB', fontSize: 13.5, outline: 'none', marginBottom: 11, minHeight: 74, resize: 'vertical' as const, fontFamily: 'inherit', boxSizing: 'border-box' as const }}
                placeholder="Tell others what you thought (optional)"
                value={reviewComment}
                onChange={e => setReviewComment(e.target.value)}
                maxLength={500}
              />
              {reviewError && <p style={{ color: '#EF4444', fontSize: 12, marginBottom: 9 }}>{reviewError}</p>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => { setShowReviewForm(false); setReviewError(''); }} style={{ flex: 1, background: '#fff', border: '1px solid #E5E7EB', borderRadius: 11, padding: 11, fontSize: 13, fontWeight: 700, color: '#6B7280', cursor: 'pointer' }}>Cancel</button>
                <button disabled={submittingReview} onClick={handleSubmitReview} style={{ flex: 2, background: theme.primary, border: 'none', borderRadius: 11, padding: 11, fontSize: 13, fontWeight: 700, color: '#fff', cursor: 'pointer', opacity: submittingReview ? 0.7 : 1 }}>
                  {submittingReview ? 'Submitting...' : 'Submit Review'}
                </button>
              </div>
            </div>
          )}

          {!showReviewForm && reviews.length === 0 && (
            <p style={{ fontSize: 13, color: '#9CA3AF', lineHeight: 1.5 }}>Be the first to share what you think about this product.</p>
          )}

          {reviews.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
              {reviews.map(r => (
                <div key={r.id} style={{ borderTop: '1px solid #F3F4F6', paddingTop: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                    <p style={{ fontSize: 13.5, fontWeight: 700, color: '#111827' }}>{r.customerName}</p>
                    <div style={{ display: 'flex', gap: 1 }}>
                      {[1, 2, 3, 4, 5].map(i => <Star key={i} size={12} color={i <= r.rating ? '#F59E0B' : '#E5E7EB'} fill={i <= r.rating ? '#F59E0B' : 'none'} />)}
                    </div>
                  </div>
                  {r.comment && <p style={{ fontSize: 13, color: '#6B7280', lineHeight: 1.55 }}>{r.comment}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 13. You May Also Like */}
      {related.length > 0 && (
        <div style={{ padding: '0 0 26px' }}>
          <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 700, color: '#111827', marginBottom: 14, padding: '0 20px' }}>You May Also Like</h3>
          <div style={{ display: 'flex', gap: 12, overflowX: 'auto' as const, padding: '0 20px 4px' }}>
            {related.map(p => (
              <Link key={p.id} to={`/${slug}/product/${p.id}`} style={{ textDecoration: 'none', width: 140, flexShrink: 0 }}>
                <div style={{ background: theme.background, borderRadius: 16, overflow: 'hidden', border: `1px solid ${theme.accent}44`, boxShadow: '0 4px 14px rgba(0,0,0,0.06)' }}>
                  <div style={{ width: '100%', aspectRatio: '1', background: `linear-gradient(135deg, ${theme.primary}12, ${theme.secondary}0a)`, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                    {p.imageUrl ? (
                      <img src={getOptimizedImageUrl(p.imageUrl, 250)} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover' as const }} loading="lazy" />
                    ) : (
                      <ProductIcon iconKey={p.emoji} size={30} color={theme.primary} />
                    )}
                  </div>
                  <div style={{ padding: '9px 10px 11px', textAlign: 'center' as const }}>
                    <p style={{ fontSize: 12, fontWeight: 700, color: '#111827', marginBottom: 4, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' as const }}>{p.name}</p>
                    <span style={{ fontSize: 12.5, fontWeight: 800, color: theme.primary }}>{NAIRA}{(p.salePrice || p.price).toLocaleString()}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* 14. Checkout / WhatsApp - final section */}
      <div style={{ padding: '0 20px', marginBottom: 24 }}>
        <div style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 14, padding: '18px 16px' }}>
          <p style={{ fontSize: 12.5, color: '#6B7280', lineHeight: 1.5 }}>Checkout is coming soon - your cart is saved for this session. In the meantime, message the seller directly to complete your order.</p>
          {merchant.contactWhatsapp && (
            <a href={`https://wa.me/${merchant.contactWhatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(`Hi, I'm interested in ${product.name}`)}`} target="_blank" rel="noreferrer" className="sp-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12, background: theme.primary, color: '#fff', borderRadius: 11, padding: '11px 18px', fontSize: 13.5, fontWeight: 700, textDecoration: 'none', transition: 'transform 0.15s ease' }}>
              <MessageCircle size={15} /> Message on WhatsApp
            </a>
          )}
        </div>
      </div>

      <StoreFooter merchant={merchant} theme={theme} slug={slug!} />
      <FloatingWhatsApp merchant={merchant} theme={theme} productName={product.name} />
    </div>
  );
}
