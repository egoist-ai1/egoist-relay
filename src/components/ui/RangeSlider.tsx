import type { ChangeEvent } from 'react';
import type { FC, TeactNode } from '../../lib/teact/teact';
import { memo, useCallback, useMemo } from '../../lib/teact/teact';

import buildClassName from '../../util/buildClassName';

import useLang from '../../hooks/useLang';

import './RangeSlider.scss';

type OwnProps = {
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  ariaLabel?: string;
  value: number;
  disabled?: boolean;
  readOnly?: boolean;
  bold?: boolean;
  className?: string;
  renderValue?: (value: number) => TeactNode;
  onChange: (value: number) => void;
  isCenteredLayout?: boolean;
};

const RangeSlider: FC<OwnProps> = ({
  options,
  min = 0,
  max = options ? options.length - 1 : 100,
  step = 1,
  label,
  ariaLabel,
  value,
  disabled,
  readOnly,
  bold,
  className,
  renderValue,
  onChange,
  isCenteredLayout,
}) => {
  const lang = useLang();
  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    if (!disabled && !readOnly) onChange(Number(event.currentTarget.value));
  }, [onChange, disabled, readOnly]);

  const mainClassName = buildClassName(
    className,
    'RangeSlider',
    disabled && 'disabled',
    readOnly && 'readOnly',
    bold && 'bold',
  );

  const trackWidth = useMemo(() => {
    const span = options ? options.length - 1 : max - min;
    if (span <= 0 || !Number.isFinite(span) || !Number.isFinite(value)) return 0;
    const percentage = ((value - (options ? 0 : min)) / span) * 100;
    return Math.max(0, Math.min(100, percentage));
  }, [options, value, max, min]);

  function renderTopRow() {
    if (isCenteredLayout) {
      return (
        <div className="slider-top-row" dir={lang.isRtl ? 'rtl' : undefined}>
          {!options && (
            <>
              <span className="value-min" dir="auto">{min}</span>
              <span className="label" dir="auto">{renderValue ? renderValue(value) : value}</span>
              <span className="value-max" dir="auto">{max}</span>
            </>
          )}
        </div>
      );
    }

    if (!label) {
      return undefined;
    }

    return (
      <div className="slider-top-row" dir={lang.isRtl ? 'rtl' : undefined}>
        <span className="label" dir="auto">{label}</span>
        {!options && (
          <span className="value" dir="auto">{renderValue ? renderValue(value) : value}</span>
        )}
      </div>
    );
  }

  return (
    <div className={mainClassName}>
      {renderTopRow()}
      <div className="slider-main">
        <div
          className="slider-fill-track"
          style={`width: ${trackWidth}%`}
        />
        <input
          min={min}
          max={max}
          value={value}
          step={step}
          type="range"
          disabled={disabled || readOnly}
          aria-label={ariaLabel || label}
          className="RangeSlider__input"
          onChange={handleChange}
        />
        {options && (
          <div className="slider-options">
            {options.map((option, index) => (
              <div
                className={buildClassName('slider-option', index === value && 'active')}
                onClick={() => { if (!disabled && !readOnly) onChange(index); }}
              >
                {option}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default memo(RangeSlider);
