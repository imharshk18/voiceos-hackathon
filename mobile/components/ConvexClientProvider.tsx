import { ConvexProvider, ConvexReactClient } from "convex/react";
import { PropsWithChildren, useMemo } from "react";

export function ConvexClientProvider({ children }: PropsWithChildren) {
  const client = useMemo(() => {
    const url = process.env.EXPO_PUBLIC_CONVEX_URL;
    if (!url) {
      throw new Error("EXPO_PUBLIC_CONVEX_URL is missing.");
    }
    return new ConvexReactClient(url);
  }, []);

  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
