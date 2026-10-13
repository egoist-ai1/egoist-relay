import { memo } from '../../lib/teact/teact';

type OwnProps = {
  size?: number;
  className?: string;
  // Перед текстом в строке: выравнивание по тексту и отступ
  isInline?: boolean;
};

// Знак Egoist Social «Реплика-E»: три полосы, нижняя переходит в хвостик реплики (источник — docs/brand/build_logo.py).
// Цвет — currentColor, поэтому следует теме.
const INLINE_STYLE = 'vertical-align: -0.125em; margin-inline-end: 0.375rem';
const GLYPH = 'M12 11H48A4 4 0 0 1 48 19H12Z M12 24.5H40A4 4 0 0 1 40 32.5H12Z M12 38H48A4 4 0 0 1 48 46H24L12 53.5Z';

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
