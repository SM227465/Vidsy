// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const dlLog = (stage: string, data?: any) => {
  console.log(`[DL_FLOW] ${new Date().toISOString()} | ${stage}`, data || '');
};
