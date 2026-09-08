import "@/index.css"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { FileComponentProvider } from "@opencode/ui/context/file"
import { Font } from "@opencode/ui/font"
import { ThemeProvider } from "@opencode/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Router } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { type Component, createRenderEffect, ErrorBoundary, type JSX, type ParentProps } from "solid-js"
import { Dynamic } from "solid-js/web"
import { CommandProvider } from "@/shell/commands/command"
import { DesktopCommands } from "@/shell/commands/desktop"
import { GlobalProvider } from "@/runtime/server/runtime"
import { HighlightsProvider } from "@/shell/updates/highlights"
import { LanguageProvider, UiI18nBridge, type Locale } from "@/runtime/i18n/language"
import { ServerConnection, ServersProvider } from "@/runtime/server/registry"
import { SettingsProvider } from "@/settings/model"
import { TabsProvider } from "@/shell/tabs/tabs"
import { WslServersProvider } from "@/servers/wsl/context"
import { ErrorPage } from "@/shell/errors/error"
import { AppRoutes, File, preloadRoute } from "@/shell/routes/routes"

export { preloadRoute }

declare global {
  interface Window {
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark"; scheme?: "system" | "light" | "dark" }) => Promise<void>
      exportDebugLogs?: () => Promise<string>
    }
  }
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
      },
    },
  })
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function BodyTypography() {
  createRenderEffect(() => {
    if (typeof document === "undefined") return
    document.body.classList.remove("text-12-regular")
    document.body.classList.add("font-(family-name:--font-family-text)", "text-[13px]", "font-[440]")
  })

  return null
}

export function AppBaseProviders(
  props: ParentProps<{
    locale?: Locale
    onNativeTranslations?: Parameters<typeof LanguageProvider>[0]["onNativeTranslations"]
    onThemeApplied?: (mode: "light" | "dark", scheme: "system" | "light" | "dark") => void
  }>,
) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode, scheme) => {
          void window.api?.setTitlebar?.({ mode, scheme })
          props.onThemeApplied?.(mode, scheme)
        }}
      >
        <LanguageProvider locale={props.locale} onNativeTranslations={props.onNativeTranslations}>
          <UiI18nBridge>
            <ErrorBoundary
              fallback={(error) => {
                void import("@sentry/solid").then(({ captureException }) => captureException(error))
                return <ErrorPage error={error} />
              }}
            >
              <QueryProvider>
                <WslServersProvider>
                  <DialogProvider>
                    <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                  </DialogProvider>
                </WslServersProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

// 子路径部署（GitHub Pages /openui/）：默认 Router 带上 vite base（import.meta.env.BASE_URL），
// 使所有 Route 路径自动加上部署前缀；调用方仍可通过 AppInterface 的 router prop 覆盖。
function PrefixedRouter(props: BaseRouterProps) {
  return <Router {...props} base={import.meta.env.BASE_URL} />
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  canonicalLocalServer?: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
}) {
  // The visual layout lives in the router root so it remains mounted across
  // route changes. Draft and session routes override only their server-bound data
  // providers beneath it.
  const Root = (rootProps: ParentProps) => (
    <TabsProvider>
      <GlobalProvider>
        <BodyTypography />
        <CommandProvider>
          <DesktopCommands />
          <HighlightsProvider>
            {props.children}
            {rootProps.children}
          </HighlightsProvider>
        </CommandProvider>
      </GlobalProvider>
    </TabsProvider>
  )

  return (
    <ServersProvider
      defaultServer={props.defaultServer}
      canonicalLocalServer={props.canonicalLocalServer}
      servers={props.servers}
    >
      <SettingsProvider>
        <Dynamic component={props.router ?? PrefixedRouter} root={Root}>
          <AppRoutes />
        </Dynamic>
      </SettingsProvider>
    </ServersProvider>
  )
}