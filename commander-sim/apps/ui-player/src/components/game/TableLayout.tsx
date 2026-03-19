import type { ReactNode } from "react";

interface TableLayoutProps {
  north: ReactNode;
  west: ReactNode;
  east: ReactNode;
  south: ReactNode;
  center: ReactNode;
}

/**
 * CSS Grid layout:
 *
 * +-------------------+
 * |      NORTH        |
 * +------+------+-----+
 * | WEST | CTR  | EAST|
 * +------+------+-----+
 * |      SOUTH        |
 * +-------------------+
 */
export default function TableLayout({ north, west, east, south, center }: TableLayoutProps) {
  return (
    <div
      className="grid h-full"
      style={{
        gridTemplateColumns: "200px 1fr 200px",
        gridTemplateRows: "auto 1fr auto",
      }}
    >
      {/* North */}
      <div className="col-span-3 border-b border-gray-700">{north}</div>

      {/* West */}
      <div className="border-r border-gray-700 overflow-auto">{west}</div>

      {/* Center */}
      <div className="overflow-auto">{center}</div>

      {/* East */}
      <div className="border-l border-gray-700 overflow-auto">{east}</div>

      {/* South */}
      <div className="col-span-3 border-t border-gray-700">{south}</div>
    </div>
  );
}
