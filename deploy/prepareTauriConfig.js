/* eslint-disable no-null/no-null */
export default function prepareTauriConfig() {
  if (process.env.WITH_UPDATER === 'true') {
    throw new Error('Relay updater is disabled until a reviewed, signed update channel is configured');
  }

  return {
    build: {
      frontendDist: '../dist',
      devUrl: null,
    },
    bundle: {
      createUpdaterArtifacts: false,
      windows: {},
    },
    identifier: 'com.egoist.relay',
  };
}
