export type LogFields = Record<string,unknown>;
export interface Telemetry {
  event(event: string,fields?: LogFields): void;
  count(name: string,labels?: Record<string,string>,value?: number): void;
  gauge(name: string,value: number,labels?: Record<string,string>): void;
  observe(name: string,seconds: number,labels?: Record<string,string>): void;
  render(): string;
}
export const NOOP_TELEMETRY: Telemetry = {
  event() {},count() {},gauge() {},observe() {},render: () => '',
};
