import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AdminApp } from "./admin/AdminApp";
import { BusinessApp } from "./app/BusinessApp";
import { I18nProvider } from "./i18n";
import { ToastProvider } from "./ui";
import "@fontsource-variable/vazirmatn/wght.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <ToastProvider>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Routes>
            <Route path="/admin/*" element={<AdminApp />} />
            <Route path="/app/*" element={<BusinessApp />} />
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </I18nProvider>
  </StrictMode>,
);
