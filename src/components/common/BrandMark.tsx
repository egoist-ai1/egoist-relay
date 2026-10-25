import { memo } from '../../lib/teact/teact';

type OwnProps = {
  size?: number;
  className?: string;
  // Перед текстом в строке: выравнивание по тексту и отступ
  isInline?: boolean;
};

// Знак «Береста»: три штриха коры, нижний уходит хвостиком реплики (источник — docs/brand/build_logo.py).
// Цвет — currentColor, поэтому следует теме.
const INLINE_STYLE = 'vertical-align: -0.125em; margin-inline-end: 0.375rem';
const GLYPH = 'M14.9 12.65H34.7A3.6 3.6 0 0 1 34.7 19.85H14.9A3.6 3.6 0 0 1 14.9 12.65Z M29.3 25.25H49.1A3.6 3.6 0 0 1 49.1 32.45H29.3A3.6 3.6 0 0 1 29.3 25.25Z M16.7 37.85H43.7A3.6 3.6 0 0 1 43.7 45.05H24.8L14 51.35V40.55A2.7 2.7 0 0 1 16.7 37.85Z';

const BrandMark = ({ size = 16, className, isInline }: OwnProps) => (
  <svg
    className={className}
    style={isInline ? INLINE_STYLE : undefined}
    width={size}
    height={size}
    viewBox="0 0 64 64"
    aria-hidden="true"
    focusable="false"
  >
    <path d={GLYPH} fill="currentColor" />
  </svg>
);

export default memo(BrandMark);
