import { Icon } from "@iconify/react";
import { DefaultSize, IconSize } from "@/types/size";

export const BNBCoinIcon = ({
  size = DefaultSize,
  className,
}: {
  size?: IconSize;
  className?: any;
}) => (
  <Icon
    color="#f0b90b"
    className={className}
    height={size.width}
    width={size.height}
    icon="mingcute:binance-coin-bnb-fill"
  />
);

export const ETHCoinIcon = ({
  size = DefaultSize,
  className,
}: {
  size?: IconSize;
  className?: any;
}) => (
  <Icon
    color="#627EEA"
    className={className}
    height={size.width}
    width={size.height}
    icon="cryptocurrency:eth"
  />
);

export const HYPECoinIcon = ({
  size = DefaultSize,
  className,
}: {
  size?: IconSize;
  className?: any;
}) => (
  <svg
    className={className}
    width={size.width}
    height={size.height}
    viewBox="0 0 144 144"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M144 71.6991C144 119.306 114.866 134.582 99.5156 120.98C86.8804 109.889 83.1211 86.4521 64.116 84.0456C39.9942 81.0113 37.9057 113.133 22.0334 113.133C3.5504 113.133 0 86.2428 0 72.4315C0 58.3063 3.96809 39.0542 19.736 39.0542C38.1146 39.0542 39.1588 66.5722 62.132 65.1073C85.0007 63.5379 85.4184 34.8689 100.247 22.6271C113.195 12.0593 144 23.4641 144 71.6991Z"
      fill="#19E3A1"
    />
  </svg>
);

export const USDCCoinIcon = ({
  size = DefaultSize,
  className,
}: {
  size?: IconSize;
  className?: any;
}) => (
  <svg
    className={className}
    width={size.width}
    height={size.height}
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="16" cy="16" r="16" fill="#2775CA" />
    <circle cx="16" cy="16" r="11.5" stroke="#FFFFFF" strokeWidth="1.5" opacity="0.9" />
    <path
      d="M17.2 9.5H15.1V11C12.5 11.3 10.9 12.8 10.9 14.9C10.9 17.3 12.8 18.2 15 18.7V21.1C13.8 20.9 12.6 20.3 11.7 19.5L10.5 21.6C11.7 22.6 13.2 23.2 15.1 23.4V25H17.2V23.4C20 23 21.5 21.4 21.5 19.2C21.5 16.9 19.7 16 17.2 15.4V13.2C18.2 13.4 19.1 13.8 19.9 14.4L21.1 12.4C20.1 11.6 18.8 11 17.2 10.8V9.5ZM15.1 15C13.8 14.6 13.3 14.2 13.3 13.5C13.3 12.8 13.9 12.3 15.1 12.1V15ZM17.2 18C18.4 18.4 19 18.8 19 19.6C19 20.3 18.4 20.9 17.2 21.1V18Z"
      fill="#FFFFFF"
    />
  </svg>
);

export const ChainCoinIcon = ({
  chainId,
  className,
  size = DefaultSize,
}: {
  chainId?: any;
  className?: any;
  size?: IconSize;
}) => {
  let icon;
  switch (chainId?.toString()) {
    case "1":
      icon = <ETHCoinIcon size={size} />;
      break;
    case "999":
      icon = <HYPECoinIcon size={size} />;
      break;
    case "56":
    case "204":
    case "5611":
      icon = <BNBCoinIcon size={size} />;
      break;
    default:
      icon = <ETHCoinIcon size={size} />;
      break;
  }

  return <div className={className}>{icon}</div>;
};

export const SymbolCoinIcon = ({
  symbol,
  chainId,
  className,
  size = DefaultSize,
}: {
  symbol?: string;
  chainId?: any;
  className?: any;
  size?: IconSize;
}) => {
  const normalized = String(symbol ?? '').toUpperCase();

  if (normalized === 'USDC') {
    return <USDCCoinIcon size={size} className={className} />;
  }

  if (normalized === 'HYPE' || normalized === 'WHYPE') {
    return <HYPECoinIcon size={size} className={className} />;
  }

  if (normalized === 'BNB' || normalized === 'WBNB') {
    return <BNBCoinIcon size={size} className={className} />;
  }

  if (normalized === 'ETH' || normalized === 'WETH') {
    return <ETHCoinIcon size={size} className={className} />;
  }

  return <ChainCoinIcon chainId={chainId} size={size} className={className} />;
};
