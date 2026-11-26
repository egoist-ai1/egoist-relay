import useLang from '../../hooks/useLang';

import Button from '../ui/Button';

type OwnProps = {
  onRetry: NoneToVoidFunction;
};

export default function MediaLoadError({ onRetry }: OwnProps) {
  const lang = useLang();

  return (
    <div className="MediaViewerRetry">
      <span role="status">{lang('RelayMediaLoadFailed')}</span>
      <Button size="smaller" color="translucent-white" shouldStopPropagation onClick={onRetry}>
        {lang('RelayRetry')}
      </Button>
    </div>
  );
}
