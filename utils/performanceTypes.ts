// Tipos del informe de rendimiento por conductor (respuesta de GET /api/users/driver-performance,
// calculada en services/driverPerformanceReport.js).

export type ClosureProfile = 'ON_TIME' | 'DELAYED' | 'END_OF_DAY' | 'NO_DATA';

export interface DailyPerformance {
  date: string; // YYYY-MM-DD (día lógico)
  assigned: number;
  delivered: number;
  hadProblem: number;
  cancelled: number;
  returned: number;
  pending: number;
  deliveryRate: number | null;
  deliveredCount: number;
  firstActivity: string | null;
  lastActivity: string | null;
  hoursActive: number | null;
  avgMinutesPerDelivery: number | null;
  paceReliable: boolean;
  mlCount: number;
  avgMlDelayMin: number | null;
  lateShare: number | null;
  maxBurst: number;
  burstAt: string | null;
  closureProfile: ClosureProfile;
}

export interface DriverPerformance {
  driverId: string;
  driverName: string;
  phone: string | null;
  totals: {
    daysWorked: number;
    assigned: number;
    delivered: number;
    pending: number;
    cancelled: number;
    returned: number;
    problemOpen: number;
    problemPackages: number;
    deliveryRate: number | null;
    incidentRate: number | null;
    photoRate: number | null;
    avgDeliveriesPerDay: number | null;
    bestDay: { date: string; delivered: number } | null;
    worstDay: { date: string; delivered: number } | null;
  };
  pace: {
    reliableDays: number;
    avgMinutesPerDelivery: number | null;
    avgHoursActive: number | null;
    avgStart: string | null;
    avgEnd: string | null;
    deliveriesPerActiveHour: number | null;
  };
  closure: {
    mlDeliveries: number;
    avgMlDelayMin: number | null;
    lateShare: number | null;
    lateCount: number;
    daysOnTime: number;
    daysDelayed: number;
    daysEndOfDay: number;
    daysNoData: number;
    appClosureDays: number;
    systemClosureDays: number;
    avgClosureTime: string | null;
  };
  mix: { source: string; count: number }[];
  byCommune: { commune: string; count: number }[];
  byHour: number[];
  problemReasons: { reason: string; count: number }[];
  daily: DailyPerformance[];
}

export interface PerformanceReport {
  period: { startDate: string; endDate: string; days: number };
  generatedAt: string;
  meta: { lateCloseMinutes: number; minMlForProfile: number; minDeliveriesForPace: number };
  drivers: DriverPerformance[];
  fleet: {
    driversCount: number;
    totals: { assigned: number; delivered: number; pending: number; cancelled: number; returned: number; problemPackages: number; mlDeliveries: number };
    averages: {
      deliveryRate: number | null;
      incidentRate: number | null;
      photoRate: number | null;
      avgDeliveriesPerDay: number | null;
      avgMinutesPerDelivery: number | null;
      avgHoursActive: number | null;
      avgMlDelayMin: number | null;
      lateShare: number | null;
      driversWithClosureData: number;
    };
  };
}

export const SOURCE_LABELS: Record<string, string> = {
  MERCADO_LIBRE: 'Mercado Libre',
  MANUAL: 'Manual / Web',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  JUMPSELLER: 'Jumpseller',
  FALABELLA: 'Falabella',
  FALABELLA_DIRECTO: 'Falabella Directo',
  OTRO: 'Otros',
};
