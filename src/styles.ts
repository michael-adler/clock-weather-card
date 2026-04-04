import { css } from 'lit'

export default css`

  ha-card {
    --bar-height: 1.5rem;
    height: 100%;
  }

  clock-weather-card-today {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  clock-weather-card-today-left {
    display: flex;
    width: 25%;
    align-items: center;
    justify-content: flex-start;
  }

  .grow-img {
    max-width: 100%;
    max-height: 100%;
  }

  clock-weather-card-today-right {
    display: flex;
    flex: 1;
    justify-content: center;
    align-items: flex-end;
    flex-direction: column;
  }

  clock-weather-card-today-temp {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 6.5rem;
    line-height: 1;
    white-space: nowrap;
  }

  .temperature-trend-icon {
    width: 1em;
    height: 1em;
    flex: 0 0 auto;
    align-self: center;
  }

  clock-weather-card-today-right-wrap-top {
    text-align: right;
    display: block;
    font-size: 1.35rem;
    line-height: 1.25;
  }

  clock-weather-card-today-right-wrap-bottom {
    text-align: right;
    font-size: 1.2rem;
    line-height: 1.2;
  }

  clock-weather-card-forecast {
    display: block;
  }

  clock-weather-card-today + clock-weather-card-forecast {
    margin-top: 1.5rem;
  }

  clock-weather-card-forecast-row {
    display: grid;
    grid-template-columns: var(--col-one-size) 2rem 2.1rem auto 2.1rem;
    align-items: center;
    grid-gap: 0.5rem;
  }

  clock-weather-card-hourly-layout {
    --hourly-row-height: 2rem;
    --hourly-row-gap: 0rem;
    --hourly-temp-height: 0.9rem;
    display: grid;
    grid-template-columns: max-content minmax(16rem, 1fr);
    gap: 0.45rem;
    align-items: start;
    min-height: auto;
  }

  clock-weather-card-hourly-left {
    display: flex;
    flex-direction: column;
    gap: var(--hourly-row-gap);
  }

  clock-weather-card-hourly-left-row {
    display: grid;
    grid-template-columns: calc(var(--col-one-size) + 1.1rem) 2rem max-content;
    align-items: center;
    column-gap: 0;
    min-height: 0;
  }

  clock-weather-card-hourly-left-row forecast-text:first-of-type {
    margin-right: 0.55rem;
  }

  clock-weather-card-hourly-left-row forecast-text:last-of-type {
    margin-right: 0;
  }

  clock-weather-card-hourly-left-row forecast-icon {
    margin-right: 0;
  }

  clock-weather-card-hourly-columns {
    display: flex;
    height: calc(
      (var(--row-count, 5) * var(--hourly-row-height))
      + ((var(--row-count, 5) - 1) * var(--hourly-row-gap))
    );
    gap: 0.35rem;
    min-height: auto;
  }

  hourly-forecast-column {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    flex: 1;
    min-width: 0;
    height: 100%;
  }

  hourly-forecast-column-plot {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    position: relative;
    width: 100%;
    min-height: 0;
    flex: 1;
  }

  hourly-forecast-column-bar {
    position: relative;
    display: flex;
    justify-content: center;
    width: 72%;
    height: var(--hourly-bar-height);
    min-height: 0.9rem;
    border-radius: 0.35rem 0.35rem 0.2rem 0.2rem;
    background: var(--bar-color);
    opacity: var(--bar-opacity, 1);
  }

  hourly-forecast-column-temp-top {
    position: absolute;
    top: 0.28rem;
    left: 50%;
    transform: translateX(-50%);
    color: var(--hourly-temp-color, #ffffff);
    font-size: 0.8rem;
    line-height: 1;
    text-align: center;
    white-space: nowrap;
    z-index: 1;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
    pointer-events: none;
  }

  hourly-forecast-column-time {
    font-size: 0.8rem;
    line-height: var(--hourly-temp-height);
    height: var(--hourly-temp-height);
    text-align: center;
    white-space: nowrap;
  }

  @media (max-width: 700px) {
    clock-weather-card-hourly-layout {
      --hourly-row-height: 2.15rem;
      grid-template-columns: 1fr;
      gap: 0.8rem;
    }
  }

  forecast-text {
    text-align: var(--text-align);
    white-space: nowrap;
    text-overflow: clip;
  }

  forecast-icon {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  forecast-temperature-bar {
    position: relative;
    width: 100%;
    height: var(--bar-height);
    border-radius: calc(var(--bar-height) / 2);
    overflow: hidden;
  }

  forecast-temperature-bar-background {
    left: 0%;
    right: 100%;
    width: 100%;
    opacity: 0.25;
    background: var(--light-primary-color);
  }

  forecast-temperature-bar-current-indicator-dot {
    --border-width: 2px;
    background-color: var(--primary-text-color);
    border-radius: 50%;
    width: var(--bar-height);
    box-shadow: inset 0 0 0 var(--border-width) var(--text-light-primary-color);
    margin-left: calc(var(--move-right) * -1 * var(--bar-height));
  }

  forecast-temperature-bar-range {
    border-radius: calc(var(--bar-height) / 2);
    left: var(--start-percent);
    right: calc(100% - var(--end-percent));
    background: linear-gradient(to right, var(--gradient));
    overflow: hidden;
    min-width: var(--bar-height);
    margin-left: calc(var(--move-right) * -1 * var(--bar-height));
  }

  forecast-temperature-bar-current-indicator {
    opacity: 0.75;
    left: var(--position);
  }

  forecast-temperature-bar-current-indicator,
  forecast-temperature-bar-current-indicator-dot,
  forecast-temperature-bar-background,
  forecast-temperature-bar-range {
    height: 100%;
    position: absolute;
  }

  aqi {
    padding: 2px;
    border-radius: 5px;
  }
`
