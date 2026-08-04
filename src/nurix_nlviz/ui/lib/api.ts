import { useQuery, useSuspenseQuery, useMutation } from "@tanstack/react-query";
import type { UseQueryOptions, UseSuspenseQueryOptions, UseMutationOptions } from "@tanstack/react-query";

export interface ChatRequest {
  question: string;
  session_id: string;
}

export interface FilterEntry {
  col: string;
  val: string;
}

export interface FilterRequest {
  filter_col?: string;
  filter_val?: string;
  filters?: FilterEntry[];
  pin_ids: number[];
  session_id: string;
}

export interface HTTPValidationError {
  detail?: ValidationError[];
}

export interface HealthOut {
  status?: string;
}

export interface PinIn {
  chart_config: string;
  chart_type: string;
  height?: number;
  question: string;
  rows_json?: unknown[] | null;
  session_id: string;
  sql_query?: string | null;
  width?: number;
  x?: number;
  y?: number;
}

export interface PinOut {
  chart_config: string;
  chart_type: string;
  created_at?: string | null;
  height?: number;
  id: number;
  question: string;
  rows_json?: unknown[] | null;
  session_id: string;
  sql_query?: string | null;
  width?: number;
  x?: number;
  y?: number;
}

export interface PinUpdateRequest {
  chart_config?: string | null;
  height?: number | null;
  width?: number | null;
  x?: number | null;
  y?: number | null;
}

export interface RefineRequest {
  chart_html: string;
  columns?: Record<string, unknown>[] | null;
  refine_instruction: string;
  session_id: string;
}

export interface ValidationError {
  ctx?: Record<string, unknown>;
  input?: unknown;
  loc: (string | number)[];
  msg: string;
  type: string;
}

export interface GetPinsParams {
  session_id: string;
}

export interface UpdatePinParams {
  pin_id: number;
}

export interface DeletePinParams {
  pin_id: number;
}

export class ApiError extends Error {
  status: number;
  statusText: string;
  body: unknown;

  constructor(status: number, statusText: string, body: unknown) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

export const chat = async (data: ChatRequest, options?: RequestInit): Promise<{ data: unknown }> => {
  const res = await fetch("/api/chat", { ...options, method: "POST", headers: { "Content-Type": "application/json", ...options?.headers }, body: JSON.stringify(data) });
  if (!res.ok) {
    const body = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { parsed = body; }
    throw new ApiError(res.status, res.statusText, parsed);
  }
  return { data: await res.json() };
};

export function useChat(options?: { mutation?: UseMutationOptions<{ data: unknown }, ApiError, ChatRequest> }) {
  return useMutation({ mutationFn: (data) => chat(data), ...options?.mutation });
}

export const applyFilter = async (data: FilterRequest, options?: RequestInit): Promise<{ data: unknown }> => {
  const res = await fetch("/api/filter", { ...options, method: "POST", headers: { "Content-Type": "application/json", ...options?.headers }, body: JSON.stringify(data) });
  if (!res.ok) {
    const body = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { parsed = body; }
    throw new ApiError(res.status, res.statusText, parsed);
  }
  return { data: await res.json() };
};

export function useApplyFilter(options?: { mutation?: UseMutationOptions<{ data: unknown }, ApiError, FilterRequest> }) {
  return useMutation({ mutationFn: (data) => applyFilter(data), ...options?.mutation });
}

export const health = async (options?: RequestInit): Promise<{ data: HealthOut }> => {
  const res = await fetch("/api/health", { ...options, method: "GET" });
  if (!res.ok) {
    const body = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { parsed = body; }
    throw new ApiError(res.status, res.statusText, parsed);
  }
  return { data: await res.json() };
};

export const healthKey = () => {
  return ["/api/health"] as const;
};

export function useHealth<TData = { data: HealthOut }>(options?: { query?: Omit<UseQueryOptions<{ data: HealthOut }, ApiError, TData>, "queryKey" | "queryFn"> }) {
  return useQuery({ queryKey: healthKey(), queryFn: () => health(), ...options?.query });
}

export function useHealthSuspense<TData = { data: HealthOut }>(options?: { query?: Omit<UseSuspenseQueryOptions<{ data: HealthOut }, ApiError, TData>, "queryKey" | "queryFn"> }) {
  return useSuspenseQuery({ queryKey: healthKey(), queryFn: () => health(), ...options?.query });
}

export const getPins = async (params: GetPinsParams, options?: RequestInit): Promise<{ data: PinOut[] }> => {
  const searchParams = new URLSearchParams();
  if (params.session_id != null) searchParams.set("session_id", String(params.session_id));
  const queryString = searchParams.toString();
  const url = queryString ? `/api/pins?${queryString}` : `/api/pins`;
  const res = await fetch(url, { ...options, method: "GET" });
  if (!res.ok) {
    const body = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { parsed = body; }
    throw new ApiError(res.status, res.statusText, parsed);
  }
  return { data: await res.json() };
};

export const getPinsKey = (params?: GetPinsParams) => {
  return ["/api/pins", params] as const;
};

export function useGetPins<TData = { data: PinOut[] }>(options: { params: GetPinsParams; query?: Omit<UseQueryOptions<{ data: PinOut[] }, ApiError, TData>, "queryKey" | "queryFn"> }) {
  return useQuery({ queryKey: getPinsKey(options.params), queryFn: () => getPins(options.params), ...options?.query });
}

export function useGetPinsSuspense<TData = { data: PinOut[] }>(options: { params: GetPinsParams; query?: Omit<UseSuspenseQueryOptions<{ data: PinOut[] }, ApiError, TData>, "queryKey" | "queryFn"> }) {
  return useSuspenseQuery({ queryKey: getPinsKey(options.params), queryFn: () => getPins(options.params), ...options?.query });
}

export const createPin = async (data: PinIn, options?: RequestInit): Promise<{ data: PinOut }> => {
  const res = await fetch("/api/pins", { ...options, method: "POST", headers: { "Content-Type": "application/json", ...options?.headers }, body: JSON.stringify(data) });
  if (!res.ok) {
    const body = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { parsed = body; }
    throw new ApiError(res.status, res.statusText, parsed);
  }
  return { data: await res.json() };
};

export function useCreatePin(options?: { mutation?: UseMutationOptions<{ data: PinOut }, ApiError, PinIn> }) {
  return useMutation({ mutationFn: (data) => createPin(data), ...options?.mutation });
}

export const updatePin = async (params: UpdatePinParams, data: PinUpdateRequest, options?: RequestInit): Promise<{ data: PinOut }> => {
  const res = await fetch(`/api/pins/${params.pin_id}`, { ...options, method: "PATCH", headers: { "Content-Type": "application/json", ...options?.headers }, body: JSON.stringify(data) });
  if (!res.ok) {
    const body = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { parsed = body; }
    throw new ApiError(res.status, res.statusText, parsed);
  }
  return { data: await res.json() };
};

export function useUpdatePin(options?: { mutation?: UseMutationOptions<{ data: PinOut }, ApiError, { params: UpdatePinParams; data: PinUpdateRequest }> }) {
  return useMutation({ mutationFn: (vars) => updatePin(vars.params, vars.data), ...options?.mutation });
}

export const deletePin = async (params: DeletePinParams, options?: RequestInit): Promise<{ data: unknown }> => {
  const res = await fetch(`/api/pins/${params.pin_id}`, { ...options, method: "DELETE" });
  if (!res.ok) {
    const body = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { parsed = body; }
    throw new ApiError(res.status, res.statusText, parsed);
  }
  return { data: await res.json() };
};

export function useDeletePin(options?: { mutation?: UseMutationOptions<{ data: unknown }, ApiError, { params: DeletePinParams }> }) {
  return useMutation({ mutationFn: (vars) => deletePin(vars.params), ...options?.mutation });
}

export const refineChart = async (data: RefineRequest, options?: RequestInit): Promise<{ data: unknown }> => {
  const res = await fetch("/api/refine", { ...options, method: "POST", headers: { "Content-Type": "application/json", ...options?.headers }, body: JSON.stringify(data) });
  if (!res.ok) {
    const body = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { parsed = body; }
    throw new ApiError(res.status, res.statusText, parsed);
  }
  return { data: await res.json() };
};

export function useRefineChart(options?: { mutation?: UseMutationOptions<{ data: unknown }, ApiError, RefineRequest> }) {
  return useMutation({ mutationFn: (data) => refineChart(data), ...options?.mutation });
}

