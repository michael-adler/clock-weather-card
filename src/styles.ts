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
    font-size: 6.5rem;
    line-height: 1;
    white-space: nowrap;
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
