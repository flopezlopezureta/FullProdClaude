import React, { useEffect, useRef } from 'react';

// Chart.js (v3) se carga por CDN en index.html, igual que en DriverPerformanceReportPage.
declare const Chart: any;

/** Dibuja una configuración de Chart.js y la destruye al desmontar o cambiar de configuración. */
export const ChartCanvas: React.FC<{ config: any; height?: number }> = ({ config, height = 240 }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current || typeof Chart === 'undefined') return;
    const chart = new Chart(ref.current, config);
    return () => chart.destroy();
  }, [config]);
  return (
    <div style={{ height, position: 'relative' }}>
      <canvas ref={ref} />
    </div>
  );
};

export default ChartCanvas;
