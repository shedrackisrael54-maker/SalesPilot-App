import { Shirt, Watch, Gem, Footprints, ShoppingBasket, Sofa, Smartphone, Sparkles } from 'lucide-react';

export const NAIRA = String.fromCharCode(8358); // \u20A6 written safely to survive any clipboard encoding issue

// SalesPilot's own Paystack public key - used by EVERY store on the platform. Merchants never
// set up their own Paystack account; all payments flow into this one account, and the platform
// owner pays out each merchant's earnings separately. Never put a secret key here - only ever
// the public key, which is safe to expose client-side by design.
export const PAYSTACK_PUBLIC_KEY = 'pk_test_ea010162c0ff3c74b210f645a381bed468f38b14';

export type StoreTheme = {
  id: string;
  name: string;
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  proOnly: boolean;
};

export type ThemeNiche = {
  id: string;
  name: string;
  themes: StoreTheme[];
};

export const THEME_NICHES: ThemeNiche[] = [
  {
    id: 'general',
    name: 'General Store',
    themes: [
      { id: 'fresh-market', name: 'Fresh Market', primary: '#16A34A', secondary: '#166534', accent: '#DCFCE7', background: '#FFFFFF', proOnly: false },
      { id: 'modern-commerce', name: 'Modern Commerce', primary: '#2563EB', secondary: '#1E3A8A', accent: '#DBEAFE', background: '#FFFFFF', proOnly: true },
      { id: 'deal-hunter', name: 'Deal Hunter', primary: '#EA580C', secondary: '#C2410C', accent: '#FFF3E0', background: '#FFFFFF', proOnly: true },
      { id: 'urban-premium', name: 'Urban Premium', primary: '#111827', secondary: '#374151', accent: '#E5E7EB', background: '#FFFFFF', proOnly: true },
    ],
  },
  {
    id: 'fashion',
    name: 'Fashion',
    themes: [
      { id: 'navy-gold', name: 'Navy & Gold', primary: '#0F172A', secondary: '#1E3A8A', accent: '#D4AF37', background: '#FFFFFF', proOnly: false },
      { id: 'black-white', name: 'Black & White', primary: '#111111', secondary: '#4B5563', accent: '#F3F4F6', background: '#FFFFFF', proOnly: true },
      { id: 'burgundy-cream', name: 'Burgundy & Cream', primary: '#8B1E3F', secondary: '#6A102A', accent: '#F7E6D6', background: '#FFF8F4', proOnly: true },
      { id: 'emerald-gold', name: 'Emerald & Gold', primary: '#047857', secondary: '#065F46', accent: '#D4AF37', background: '#FFFFFF', proOnly: true },
    ],
  },
  {
    id: 'beauty',
    name: 'Beauty',
    themes: [
      { id: 'rose-pink', name: 'Rose Pink & White', primary: '#E75480', secondary: '#C2185B', accent: '#FCE4EC', background: '#FFFFFF', proOnly: false },
      { id: 'lavender-luxe', name: 'Lavender Luxe', primary: '#8B5CF6', secondary: '#6D28D9', accent: '#EDE9FE', background: '#FFFFFF', proOnly: true },
      { id: 'nude-beige', name: 'Nude Beige & Gold', primary: '#DCC1A5', secondary: '#B99A7A', accent: '#D4AF37', background: '#FFF7F1', proOnly: true },
      { id: 'soft-purple', name: 'Soft Purple', primary: '#A78BFA', secondary: '#7C3AED', accent: '#F3E8FF', background: '#FFFFFF', proOnly: true },
    ],
  },
  {
    id: 'electronics',
    name: 'Electronics',
    themes: [
      { id: 'royal-blue', name: 'Royal Blue', primary: '#2563EB', secondary: '#1E40AF', accent: '#DBEAFE', background: '#FFFFFF', proOnly: false },
      { id: 'cyan-tech', name: 'Cyan Tech', primary: '#06B6D4', secondary: '#155E75', accent: '#CFFAFE', background: '#FFFFFF', proOnly: true },
      { id: 'black-electric', name: 'Black & Electric Blue', primary: '#111827', secondary: '#2563EB', accent: '#BFDBFE', background: '#FFFFFF', proOnly: true },
      { id: 'indigo-tech', name: 'Indigo Tech', primary: '#4338CA', secondary: '#312E81', accent: '#E0E7FF', background: '#FFFFFF', proOnly: true },
    ],
  },
  {
    id: 'home',
    name: 'Home & Furniture',
    themes: [
      { id: 'walnut-cream', name: 'Walnut & Cream', primary: '#8B5E3C', secondary: '#6F4E37', accent: '#F5E9DA', background: '#FFFDF8', proOnly: false },
      { id: 'olive-beige', name: 'Olive & Beige', primary: '#556B2F', secondary: '#3F4F1E', accent: '#E8E2D0', background: '#FFFDF8', proOnly: true },
      { id: 'charcoal-white', name: 'Charcoal & White', primary: '#374151', secondary: '#1F2937', accent: '#E5E7EB', background: '#FFFFFF', proOnly: true },
      { id: 'terracotta-sand', name: 'Terracotta & Sand', primary: '#C96A3D', secondary: '#A0522D', accent: '#F4E1D2', background: '#FFF8F2', proOnly: true },
    ],
  },
  {
    id: 'food',
    name: 'Food & Restaurant',
    themes: [
      { id: 'tomato-red', name: 'Tomato Red', primary: '#DC2626', secondary: '#991B1B', accent: '#FEE2E2', background: '#FFFFFF', proOnly: false },
      { id: 'deep-green', name: 'Deep Green', primary: '#166534', secondary: '#14532D', accent: '#DCFCE7', background: '#FFFDF8', proOnly: true },
      { id: 'orange-bistro', name: 'Orange Bistro', primary: '#EA580C', secondary: '#C2410C', accent: '#FED7AA', background: '#FFFFFF', proOnly: true },
      { id: 'black-gold-food', name: 'Black & Gold', primary: '#111827', secondary: '#1F2937', accent: '#D4AF37', background: '#FFFFFF', proOnly: true },
    ],
  },
  {
    id: 'kids',
    name: 'Baby & Kids',
    themes: [
      { id: 'sky-blue', name: 'Sky Blue', primary: '#38BDF8', secondary: '#0284C7', accent: '#E0F2FE', background: '#FFFFFF', proOnly: false },
      { id: 'peach', name: 'Peach', primary: '#FDBA74', secondary: '#FB923C', accent: '#FFEDD5', background: '#FFFDF8', proOnly: true },
      { id: 'yellow-mint', name: 'Yellow & Mint', primary: '#FACC15', secondary: '#86EFAC', accent: '#ECFCCB', background: '#FFFFFF', proOnly: true },
      { id: 'purple-pink', name: 'Purple & Pink', primary: '#A855F7', secondary: '#EC4899', accent: '#F3E8FF', background: '#FFFFFF', proOnly: true },
    ],
  },
  {
    id: 'jewelry',
    name: 'Jewelry & Luxury',
    themes: [
      { id: 'black-gold-lux', name: 'Black & Gold', primary: '#111111', secondary: '#2D2D2D', accent: '#D4AF37', background: '#FFFFFF', proOnly: false },
      { id: 'white-gold', name: 'White & Gold', primary: '#D4AF37', secondary: '#B8860B', accent: '#FFF8E7', background: '#FAFAFA', proOnly: true },
      { id: 'emerald-gold-lux', name: 'Emerald & Gold', primary: '#047857', secondary: '#065F46', accent: '#D4AF37', background: '#FFFFFF', proOnly: true },
      { id: 'burgundy-gold', name: 'Burgundy & Gold', primary: '#7F1D1D', secondary: '#991B1B', accent: '#D4AF37', background: '#FFF8F4', proOnly: true },
    ],
  },
];

export type DescriptionSection = {
  title: string;
  text: string;
};

export type OptionGroup = {
  name: string;
  values: string[];
};

export type Product = {
  id: string;
  name: string;
  price: number;
  salePrice: number | null;
  status: 'In stock' | 'Low stock' | 'Out of stock';
  quantity?: number;
  badge: 'None' | 'New' | 'Hot' | 'Sale';
  emoji: string;
  imageUrl?: string;
  images?: string[];
  description?: string;
  descriptionSections?: DescriptionSection[];
  options?: OptionGroup[];
  category?: string;
  minOrderQty?: number;
  maxOrderQty?: number;
  priceTiers?: { minQty: number; price: number }[];
};

export type Review = {
  id: string;
  productId: string;
  productName: string;
  customerName: string;
  rating: number;
  comment: string;
  createdAt: string;
};

export const PRODUCT_CATEGORIES = [
  'Fashion & Clothing', 'Shoes & Footwear', 'Bags & Accessories', 'Jewelry & Watches',
  'Beauty & Skincare', 'Electronics & Gadgets', 'Home & Furniture', 'Food & Groceries',
  'Baby & Kids', 'Health & Wellness', 'Other',
];

export const PRODUCT_ICON_MAP: { [key: string]: any } = {
  shirt: Shirt,
  dress: Shirt,
  kaftan: Shirt,
  shoe: Footprints,
  bag: ShoppingBasket,
  watch: Watch,
  jewelry: Gem,
  heels: Footprints,
  beauty: Sparkles,
  food: ShoppingBasket,
  furniture: Sofa,
  electronics: Smartphone,
};
export const PRODUCT_ICON_KEYS = Object.keys(PRODUCT_ICON_MAP);

export function ProductIcon({ iconKey, size = 24, color }: { iconKey: string; size?: number; color?: string }) {
  const IconComponent = PRODUCT_ICON_MAP[iconKey] || ShoppingBasket;
  return <IconComponent size={size} color={color} />;
}

// Compresses and resizes an image in the browser before upload, to keep Firebase Storage
// costs and load times down. Keeps the image under maxDimension on its longest side and
// re-encodes as JPEG at the given quality. Falls back to the original file if anything fails.
export function compressImage(file: File, maxDimension = 1280, quality = 0.75): Promise<File> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(file); return; }
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (!blob) { resolve(file); return; }
          const newName = file.name.replace(/\.[^.]+$/, '') + '.jpg';
          resolve(new File([blob], newName, { type: 'image/jpeg' }));
        }, 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file); };
      img.src = objectUrl;
    } catch {
      resolve(file);
    }
  });
}

// Cloudinary is used for image hosting instead of Firebase Storage, since Firebase's
// billing upgrade is currently blocked by a Google-side account issue. Cloudinary's
// free tier (25GB storage, 25GB bandwidth/month) needs no billing setup at all.
const CLOUDINARY_CLOUD_NAME = 'xd2hkwf8';
const CLOUDINARY_UPLOAD_PRESET = 'wvgrzjul';

export async function uploadToCloudinary(file: File, folder?: string): Promise<string> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  if (folder) formData.append('folder', folder);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      throw new Error('Image upload failed. Please check your connection and try again.');
    }
    const data = await response.json();
    return data.secure_url as string;
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Upload timed out. Your connection may be slow - please try again.');
    }
    throw err;
  }
}

// Detects whether a value merchants typed for a product option (e.g. "Red", "Navy Blue")
// is a real color the browser understands, so we can render an actual color swatch
// automatically. Falls back gracefully to a plain text chip for anything unrecognized.
export function isValidCSSColor(value: string): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.createElement('option');
  el.style.color = '';
  el.style.color = value;
  return el.style.color !== '';
}

// An option group counts as a "color" group if its name looks like one - this drives
// whether we show swatch circles instead of plain text chips for its values.
export function isColorOptionGroup(groupName: string): boolean {
  return /colou?r/i.test(groupName);
}

export type OrderItem = {
  productId?: string;
  name: string;
  price: number;
  quantity: number;
  options?: { [k: string]: string };
};

export type Order = {
  id: string;
  reference: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  deliveryState: string;
  deliveryCity: string;
  deliveryAddress: string;
  items: OrderItem[];
  subtotal: number;
  discount: number;
  couponCode?: string;
  shippingFee: number;
  total: number;
  paymentMethod: 'Paystack' | 'WhatsApp';
  status: 'Pending' | 'Processing' | 'Completed' | 'Cancelled';
  createdAt: string;
  accessToken: string;
};

export type Bundle = {
  id: string;
  name: string;
  productIds: string[];
  bundlePrice: number;
  active: boolean;
  createdAt: string;
};

// Given a product's normal price, its wholesale/tiered pricing rules (if any), and the quantity
// being bought, returns the correct per-unit price to charge - the highest-quantity tier the
// order qualifies for. Falls back to the normal price if no tiers apply.
export function getTieredPrice(basePrice: number, tiers: { minQty: number; price: number }[] | undefined, quantity: number): number {
  if (!tiers || tiers.length === 0) return basePrice;
  const sorted = [...tiers].sort((a, b) => a.minQty - b.minQty);
  let price = basePrice;
  for (const tier of sorted) {
    if (quantity >= tier.minQty) price = tier.price;
  }
  return price;
}

export const NIGERIAN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno',
  'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT - Abuja', 'Gombe',
  'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos',
  'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto',
  'Taraba', 'Yobe', 'Zamfara',
];