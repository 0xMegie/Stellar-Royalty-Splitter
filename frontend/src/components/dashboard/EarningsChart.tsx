import React from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { formatCurrency } from "../../utils/format";

export interface TrendPoint {
  date: string;
  amount: number;
  count: number;
}

interface EarningsChartProps {
  trends: TrendPoint[];
  displayCurrency: string;
}

/**
 * EarningsChart — renders two charts side-by-side:
 * 1. Revenue Trends (line chart, amount over time)
 * 2. Distribution Frequency (bar chart, transaction count over time)
 */
export const EarningsChart: React.FC<EarningsChartProps> = ({
  trends,
  displayCurrency,
}) => {
  const noData = <div className="no-data">No data available</div>;

  return (
    <div className="charts-section">
      <div className="chart-container">
        <h2>Revenue Trends (Over Time)</h2>
        {trends.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={trends}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip
                formatter={(value) =>
                  typeof value === "number"
                    ? formatCurrency(value, displayCurrency)
                    : value
                }
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="amount"
                stroke="#667eea"
                name={`Total Amount (${displayCurrency})`}
                strokeWidth={2}
                dot={{ fill: "#667eea", r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          noData
        )}
      </div>

      <div className="chart-container">
        <h2>Distribution Frequency</h2>
        {trends.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={trends}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar dataKey="count" fill="#764ba2" name="Number of Transactions" />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          noData
        )}
      </div>
    </div>
  );
};

export default EarningsChart;
