import {
  BarChart,
  Bar,
  LineChart,
  Line,
  ScatterChart,
  Scatter,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { CHART_COLORS } from '../config/branding';

interface ChartConfig {
  xKey?: string;
  yKey?: string;
  nameKey?: string;
  dataKey?: string;
}

interface ChartRendererProps {
  chartType: string;
  config: ChartConfig;
  data: Record<string, unknown>[];
  height?: number;
}

export function ChartRenderer({ chartType, config, data, height = 320 }: ChartRendererProps) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        No data to display
      </div>
    );
  }

  const xKey = config.xKey || Object.keys(data[0] || {})[0] || 'x';
  const yKey = config.yKey || Object.keys(data[0] || {})[1] || 'y';
  const nameKey = config.nameKey || xKey;
  const dataKey = config.dataKey || yKey;

  const commonProps = {
    data,
    margin: { top: 8, right: 24, left: 0, bottom: 40 },
  };

  const axisStyle = {
    tick: { fontSize: 11, fill: '#6b7280' },
    tickLine: false,
    axisLine: { stroke: '#e5e7eb' },
  };

  switch (chartType) {
    case 'line': {
      const avg =
        data.reduce((sum, d) => sum + Number(d[yKey] || 0), 0) / (data.length || 1);
      return (
        <ResponsiveContainer width="100%" height={height}>
          <LineChart {...commonProps}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey={xKey} {...axisStyle} angle={-30} textAnchor="end" />
            <YAxis {...axisStyle} />
            <Tooltip
              contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid #e5e7eb' }}
            />
            <Legend />
            <ReferenceLine y={avg} stroke="#9ca3af" strokeDasharray="4 4" label={{ value: 'Avg', fontSize: 10 }} />
            <Line
              type="monotone"
              dataKey={yKey}
              stroke={CHART_COLORS[0]}
              strokeWidth={2}
              dot={data.length < 50}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      );
    }

    case 'scatter': {
      return (
        <ResponsiveContainer width="100%" height={height}>
          <ScatterChart {...commonProps}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey={xKey} name={xKey} {...axisStyle} />
            <YAxis dataKey={yKey} name={yKey} {...axisStyle} />
            <Tooltip
              cursor={{ strokeDasharray: '3 3' }}
              contentStyle={{ fontSize: 12, borderRadius: 6 }}
            />
            <Scatter data={data} fill={CHART_COLORS[0]} />
          </ScatterChart>
        </ResponsiveContainer>
      );
    }

    case 'pie': {
      return (
        <ResponsiveContainer width="100%" height={height}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="45%"
              outerRadius={Math.min(height * 0.38, 120)}
              dataKey={dataKey}
              nameKey={nameKey}
              label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(1)}%`}
              labelLine
            >
              {data.map((_, index) => (
                <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6 }} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      );
    }

    case 'counter': {
      const value = data[0]?.[dataKey] ?? data[0]?.[yKey] ?? Object.values(data[0] || {})[0];
      const label = dataKey || yKey;
      const formatted =
        typeof value === 'number' ? value.toLocaleString() : String(value ?? '—');

      return (
        <div className="flex flex-col items-center justify-center py-8">
          <div className="text-5xl font-bold" style={{ color: CHART_COLORS[0] }}>
            {formatted}
          </div>
          <div className="mt-2 text-sm text-muted-foreground capitalize">{label}</div>
        </div>
      );
    }

    case 'bar':
    default: {
      return (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart {...commonProps}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis
              dataKey={xKey}
              {...axisStyle}
              angle={data.length > 8 ? -30 : 0}
              textAnchor={data.length > 8 ? 'end' : 'middle'}
            />
            <YAxis {...axisStyle} />
            <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid #e5e7eb' }} />
            <Legend />
            <Bar dataKey={yKey} radius={[3, 3, 0, 0]}>
              {data.map((_, index) => (
                <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
  }
}
