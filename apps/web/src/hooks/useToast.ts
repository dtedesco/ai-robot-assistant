import { useToastContext, type ToastApi } from "@/components/Toast";

/**
 * Minimal toast API: `const toast = useToast(); toast.success("...")`.
 */
export function useToast(): ToastApi {
  return useToastContext();
}
