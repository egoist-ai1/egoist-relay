import InlineSocialMedia from '../middle/message/InlineSocialMedia';

// This short public sample is fixed so the isolated fixture accepts no URL or account data.
const SOURCE = {
  provider: 'youtube' as const,
  id: 'jNQXAC9IVRw',
  canonicalUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  isVertical: false,
};

export default function YouTubePlayerSmoke() {
  return (
    <section
      aria-label="YouTube embedded player test"
      style={[
        'position:fixed;top:64px;left:80px;width:360px;min-height:245px;',
        'z-index:2147483640;background:#111;color:#fff',
      ].join('')}
    >
      <InlineSocialMedia source={SOURCE} canAutoLoad isMessageListActive />
    </section>
  );
}
