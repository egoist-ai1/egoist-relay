type TLottieClass = typeof import('./TLottie').default;

let promise: Promise<TLottieClass> | undefined;
let tlottie: TLottieClass | undefined;

export async function ensureTLottie() {
  promise ||= import('./TLottie').then((module) => {
    tlottie = module.default;
    return tlottie;
  }).catch((error: unknown) => {
    promise = undefined;
    throw error;
  });

  return promise;
}

export function getTLottie() {
  return tlottie;
}
