export interface UiNotification {
  id: string;
  type: "waiter" | "bell" | "general";
  title: string;
  description: string;
  createdAt: number;
  read: boolean;
}

export interface CallNotification {
  id: string;
  type: "waiter" | "bell";
  title: string;
  description: string;
  createdAt: number;
  confirmed: boolean;
  confirmedAt?: number;
  orderId?: string;
  sourceNotificationId?: string;
}
