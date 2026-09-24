
export enum Role {
  Admin = 'ADMIN',
  OperadorSistemas = 'OPERADOR_SISTEMAS',
  Client = 'CLIENT',
  Driver = 'DRIVER',
  Facturacion = 'FACTURACION',
  Retiros = 'RETIROS',
  Auxiliar = 'AUXILIAR',
}

export enum UserStatus {
  Pending = 'PENDIENTE',
  Approved = 'APROBADO',
  Disabled = 'DESHABILITADO',
  Deleted = 'ELIMINADO',
}

export enum PackageStatus {
  Pending = 'PENDIENTE',
  Assigned = 'ASIGNADO',
  PickedUp = 'RETIRADO',
  InTransit = 'EN_TRANSITO',
  Delivered = 'ENTREGADO',
  Delayed = 'RETRASADO',
  Problem = 'PROBLEMA',
  ReturnPending = 'PENDIENTE_DEVOLUCION',
  Returned = 'DEVUELTO',
  Cancelled = 'CANCELADO',
  Rescheduled = 'REPROGRAMADO',
}

export enum ShippingType {
  SameDay = 'SAME_DAY',
  Express = 'EXPRESS',
  NextDay = 'NEXT_DAY',
}

export enum PickupStatus {
  ASIGNADO = 'ASIGNADO',
  EN_RUTA = 'EN_RUTA',
  RETIRADO = 'RETIRADO',
  EN_BODEGA = 'EN_BODEGA',
  NO_RETIRADO = 'NO_RETIRADO',
}

export enum PickupShift {
  MANANA = 'MANANA',
  TARDE = 'TARDE',
  NOCHE = 'NOCHE',
}

export enum AssignmentStatus {
  PreAssigned = 'PRE_ASIGNADO',
  Pending = 'PENDIENTE',
  Completed = 'COMPLETADO',
}

export enum PackageSource {
  Manual = 'MANUAL',
  MercadoLibre = 'MERCADO_LIBRE',
  Shopify = 'SHOPIFY',
  WooCommerce = 'WOOCOMMERCE',
  Falabella = 'FALABELLA',
  FalabellaDirect = 'FALABELLA_DIRECTO',
  Jumpseller = 'JUMPSELLER',
}

export enum MessagingPlan {
  None = 'NONE',
  Email = 'EMAIL',
  WhatsApp = 'WHATSAPP',
}

export enum PickupMode {
  Scan = 'SCAN',
  Manual = 'MANUAL',
  ScanWithCount = 'SCAN_COUNT',
  Colecta = 'COLECTA',
}

export enum LabelFormat {
  CompactThermal = 'compact_thermal',
  FullThermal = 'full_thermal',
  A4Single = 'a4_single',
  A4Half = 'a4_half',
  ZebraZpl = 'zebra_zpl',
  MinimalSticker = 'minimal_sticker',
  LetterMulti = 'letter_multi',
  Thermal10x8 = 'thermal_10x8',
}

// MapTiler, on Fabian's own account/API key — not the OSM Foundation's own rate-limited
// tile.openstreetmap.org (started returning "Access blocked" placeholder tiles across every
// map in the app on 2026-09-23 for exceeding its volunteer-run usage policy, osm.wiki/Blocked),
// and not CARTO's anonymous basemap CDN either (that one started watermarking tiles with
// "API KEY REQUIRED" at this app's traffic volume the same day). A signed-in key on a real
// account is the only one of the three that doesn't degrade under load.
const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY;
export const MAP_TILE_URL = `https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`;
export const MAP_TILE_ATTRIBUTION = '&copy; <a href="https://www.maptiler.com/copyright/" target="_blank">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors';
export const MAP_TILE_OPTIONS = { maxZoom: 20 };

export const DEFAULT_OPERATOR_PERMISSIONS = {
  canManageDrivers: true,
  canManageClients: true,
  canManagePackages: true,
  canDeletePackages: false,
  canManageZones: true,
  canManageSystem: false,
  canManageIntegrations: false,
  canViewReports: true,
  canManageInvoices: true,
  canBulkActions: true
};
