import { memo } from '../../lib/teact/teact';

type OwnProps = {
  size?: number;
  className?: string;
  // Перед текстом в строке: выравнивание по тексту и отступ
  isInline?: boolean;
};

// Знак Sennit: S из трёх полос (источник — docs/brand/mark.svg). Цвет — currentColor, поэтому следует теме.
const INLINE_STYLE = 'vertical-align: -0.125em; margin-inline-end: 0.375rem';

const SennitMark = ({ size = 16, className, isInline }: OwnProps) => (
  <svg
    className={className}
    style={isInline ? INLINE_STYLE : undefined}
    width={size}
    height={size}
    viewBox="0 0 64 64"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <mask id="sennit-mark-gaps" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
      <rect width="64" height="64" fill="#fff" />
      <rect y="21.5" width="64" height="3.5" />
      <rect y="39" width="64" height="3.5" />
    </mask>
    <path
      d="M50 14.5H25A8.75 8.75 0 0 0 25 32H39A8.75 8.75 0 0 1 39 49.5H14"
      stroke="currentColor"
      stroke-width="9"
      mask="url(#sennit-mark-gaps)"
    />
  </svg>
);

export default memo(SennitMark);
