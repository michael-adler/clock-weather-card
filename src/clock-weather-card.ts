import { LitElement, html, type TemplateResult, type PropertyValues, type CSSResultGroup } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import {
  type HomeAssistant,
  hasConfigOrEntityChanged,
  hasAction,
  type ActionHandlerEvent,
  handleAction,
  TimeFormat,
  type ActionConfig
} from 'custom-card-helpers' // This is a community maintained npm module with common helper functions/types. https://github.com/custom-cards/custom-card-helpers

import {
  type ClockWeatherCardConfig,
  type MergedClockWeatherCardConfig,
  type MergedWeatherForecast,
  Rgb,
  type TemperatureSensor,
  type TemperatureUnit,
  type HumiditySensor,
  type Weather,
  WeatherEntityFeature,
  type WeatherForecast,
  type WeatherForecastEvent
} from './types'
import styles from './styles'
import { actionHandler } from './action-handler-directive'
import { localize } from './localize/localize'
import { type HassEntity, type HassEntityBase } from 'home-assistant-js-websocket'
import { extractMostOccuring, max, min, roundIfNotNull, roundUp, windBearingToDirection } from './utils'
import { animatedIcons, staticIcons, temperatureTrendIcons } from './images'
import { version } from '../package.json'
import { safeRender } from './helpers'
import { DateTime } from 'luxon'

type TemperatureTrend = 'stable' | 'rising' | 'falling'

console.info(
  `%c  CLOCK-WEATHER-CARD \n%c Version: ${version}`,
  'color: orange; font-weight: bold; background: black',
  'color: white; font-weight: bold; background: dimgray'
);

// This puts your card into the UI card picker dialog
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).customCards = (window as any).customCards || [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).customCards.push({
  type: 'clock-weather-card',
  name: 'Clock Weather Card',
  description: 'Shows the current date/time in combination with the current weather and an iOS insipired weather forecast.'
})

const gradientMap: Map<number, Rgb> = new Map()
  .set(-20, new Rgb(0, 60, 98)) // dark blue
  .set(-10, new Rgb(120, 162, 204)) // darker blue
  .set(0, new Rgb(164, 195, 210)) // light blue
  .set(10, new Rgb(121, 210, 179)) // turquoise
  .set(20, new Rgb(252, 245, 112)) // yellow
  .set(30, new Rgb(255, 150, 79)) // orange
  .set(40, new Rgb(255, 192, 159)) // red

@customElement('clock-weather-card')
export class ClockWeatherCard extends LitElement {
  // https://lit.dev/docs/components/properties/
  @property({ attribute: false }) public hass!: HomeAssistant

  @state() private config!: MergedClockWeatherCardConfig
  @state() private currentDate!: DateTime
  @state() private forecasts?: WeatherForecast[]
  @state() private twiceDailyForecasts?: WeatherForecast[]
  @state() private hourlyForecasts?: WeatherForecast[]
  @state() private todayHistoricalMinTemp?: number | null
  @state() private error?: TemplateResult
  @state() private temperatureTrend: TemperatureTrend = 'stable'
  @state() private cachedHourlyColumns?: Array<{
    timeText: string
    tempText: string
    tempColor: string
    barHeightPercent: number
    color: string
    isCurrent: boolean
  }>

  private cachedHourlyColumnsCacheKey?: string
  private readonly historicalTemperatureCache = new Map<string, Map<string, number>>()
  private forecastSubscriber?: () => Promise<void>
  private forecastSubscriberLock = false
  private twiceDailyForecastSubscriber?: () => Promise<void>
  private twiceDailyForecastSubscriberLock = false
  private hourlyForecastSubscriber?: () => Promise<void>
  private hourlyForecastSubscriberLock = false

  constructor () {
    super()
    this.currentDate = DateTime.now()
    const msToNextSecond = (1000 - this.currentDate.millisecond)
    setTimeout(() => setInterval(() => { this.currentDate = DateTime.now() }, 1000), msToNextSecond)
    setTimeout(() => { this.currentDate = DateTime.now() }, msToNextSecond)
  }

  public static getStubConfig (_hass: HomeAssistant, entities: string[], entitiesFallback: string[]): Record<string, unknown> {
    const entity = entities.find(e => e.startsWith('weather.') ?? entitiesFallback.find(() => true))
    if (entity) {
      return { entity }
    }

    return {}
  }

  public getCardSize (): number {
    return 3 + roundUp(this.config.forecast_rows / 2)
  }

  // https://lit.dev/docs/components/properties/#accessors-custom
  public setConfig (config?: ClockWeatherCardConfig): void {
    if (!config) {
      throw this.createError('Invalid configuration.')
    }

    if (!config.entity) {
      throw this.createError('Attribute "entity" must be present.')
    }

    if (config.forecast_rows && config.forecast_rows < 1) {
      throw this.createError('Attribute "forecast_rows" must be greater than 0.')
    }

    if (config.hourly_columns !== undefined && config.hourly_columns < 1) {
      throw this.createError('Attribute "hourly_columns" must be greater than 0.')
    }

    if (config.time_format && config.time_format.toString() !== '24' && config.time_format.toString() !== '12') {
      throw this.createError('Attribute "time_format" must either be "12" or "24".')
    }

    if (config.hide_today_section && config.hide_forecast_section) {
      throw this.createError('Attributes "hide_today_section" and "hide_forecast_section" must not enabled at the same time.')
    }

    this.config = this.mergeConfig(config)
  }

  // https://lit.dev/docs/components/lifecycle/#reactive-update-cycle-performing
  protected shouldUpdate (changedProps: PropertyValues): boolean {
    if (!this.config) {
      return false
    }

    if (changedProps.has('forecasts') || changedProps.has('twiceDailyForecasts') || changedProps.has('hourlyForecasts') || changedProps.has('temperatureTrend')) {
      return true
    }

    const oldHass = changedProps.get('hass') as HomeAssistant | undefined
    if (oldHass) {
      const oldSun = oldHass.states[this.config.sun_entity]
      const newSun = this.hass.states[this.config.sun_entity]
      if (oldSun !== newSun) {
        return true
      }
    }

    return hasConfigOrEntityChanged(this, changedProps, false)
  }

  protected updated (changedProps: PropertyValues): void {
    super.updated(changedProps)
    if (changedProps.has('config')) {
      void this.subscribeForecastEvents()
      void this.subscribeTwiceDailyForecastEvents()
      void this.subscribeHourlyForecastEvents()
    }
  }

  // https://lit.dev/docs/components/rendering/
  protected render (): TemplateResult {
    if (this.error) {
      return this.error
    }

    const showToday = !this.config.hide_today_section
    const showForecast = !this.config.hide_forecast_section
    return html`
      <ha-card
        @action=${(e: ActionHandlerEvent) => { this.handleAction(e) }}
        .actionHandler=${actionHandler({
      hasHold: hasAction(this.config.hold_action as ActionConfig | undefined),
      hasDoubleClick: hasAction(this.config.double_tap_action as ActionConfig | undefined)
    })}
        tabindex="0"
        .label=${`Clock Weather Card: ${this.config.entity || 'No Entity Defined'}`}
      >
        ${this.config.title
        ? html`
          <div class="card-header">
            ${this.config.title}
          </div>`
        : ''}
        <div class="card-content">
          ${showToday
        ? html`
            <clock-weather-card-today>
              ${safeRender(() => this.renderToday())}
            </clock-weather-card-today>`
        : ''}
          ${showForecast
        ? html`
            <clock-weather-card-forecast>
              ${safeRender(() => this.renderForecast())}
            </clock-weather-card-forecast>`
        : ''}
        </div>
      </ha-card>
    `
  }

  public connectedCallback (): void {
    super.connectedCallback()
    if (this.hasUpdated) {
      void this.subscribeForecastEvents()
      void this.subscribeTwiceDailyForecastEvents()
      void this.subscribeHourlyForecastEvents()
    }
  }

  public disconnectedCallback (): void {
    super.disconnectedCallback()
    void this.unsubscribeForecastEvents()
    void this.unsubscribeTwiceDailyForecastEvents()
    void this.unsubscribeHourlyForecastEvents()
  }

  protected willUpdate (changedProps: PropertyValues): void {
    super.willUpdate(changedProps)
    if (!this.forecastSubscriber) {
      void this.subscribeForecastEvents()
    }

    if (!this.twiceDailyForecastSubscriber) {
      void this.subscribeTwiceDailyForecastEvents()
    }

    if (!this.hourlyForecastSubscriber) {
      void this.subscribeHourlyForecastEvents()
    }

    if ((changedProps.has('hass') || changedProps.has('hourlyForecasts') || changedProps.has('config')) && this.config) {
      void this.updateTemperatureTrend()
    }

    if ((changedProps.has('hass') || changedProps.has('hourlyForecasts') || changedProps.has('currentDate') || changedProps.has('config')) && this.config) {
      // Fetch hourly columns data when forecasts, current hour, or config changes
      void this.updateCachedHourlyColumns()
    }

    if ((changedProps.has('hass') || changedProps.has('config') || changedProps.has('twiceDailyForecasts')) && this.config) {
      void this.updateTodayHistoricalMinTemperature()
    }
  }

  private async updateCachedHourlyColumns (): Promise<void> {
    if (!this.config || !this.forecasts) {
      this.cachedHourlyColumns = undefined
      this.cachedHourlyColumnsCacheKey = undefined
      return
    }

    const temperatureUnit = this.getWeather().attributes.temperature_unit
    const hourKey = this.toZonedDate(this.currentDate).startOf('hour').toISO()
    const sourceEntity = this.config.temperature_sensor ?? this.config.entity
    const cacheKey = `${hourKey}-${this.config.hourly_columns}-${temperatureUnit}-${sourceEntity}`

    if (this.cachedHourlyColumnsCacheKey === cacheKey && this.cachedHourlyColumns) {
      return // Cache is still valid
    }

    try {
      this.cachedHourlyColumns = await this.getHourlyColumns(this.config.hourly_columns, temperatureUnit)
      this.cachedHourlyColumnsCacheKey = cacheKey
    } catch (e) {
      console.error('Error updating cached hourly columns', e)
      this.cachedHourlyColumns = undefined
      this.cachedHourlyColumnsCacheKey = undefined
    }
  }

  private async updateTodayHistoricalMinTemperature (): Promise<void> {
    if (!this.config || !this.hass) {
      this.todayHistoricalMinTemp = null
      return
    }

    // This fallback is only relevant for integrations that support twice-daily forecasts.
    if (!this.supportsFeature(WeatherEntityFeature.FORECAST_TWICE_DAILY)) {
      this.todayHistoricalMinTemp = null
      return
    }

    try {
      const temperatureUnit = this.getWeather().attributes.temperature_unit
      this.todayHistoricalMinTemp = await this.getTodayHistoricalMinTemperature(temperatureUnit)
    } catch (e) {
      console.error('Error updating today historical minimum temperature', e)
      this.todayHistoricalMinTemp = null
    }
  }

  private renderToday (): TemplateResult {
    const weather = this.getWeather()
    const state = weather.state
    const temp = this.config.show_decimal ? this.getCurrentTemperature() : roundIfNotNull(this.getCurrentTemperature())
    const tempUnit = weather.attributes.temperature_unit
    const apparentTemp = this.config.show_decimal ? this.getApparentTemperature() : roundIfNotNull(this.getApparentTemperature())
    const aqi = this.getAqi()
    const aqiBackgroundColor = this.getAqiBackgroundColor(aqi)
    const aqiTextColor = this.getAqiTextColor(aqi)
    const humidity = roundIfNotNull(this.getCurrentHumidity())
    const windInfo = this.getWindInfo()
    const iconType = this.config.weather_icon_type
    const icon = this.toIcon(state, iconType, false, this.getIconAnimationKind())
    const weatherString = this.localize(`weather.${state}`)
    const localizedTemp = temp !== null ? this.toConfiguredTempWithUnit(tempUnit, temp) : null
    const localizedHumidity = humidity !== null ? `${humidity}% ${this.localize('misc.humidity')}` : null
    const localizedApparent = apparentTemp !== null ? this.toConfiguredTempWithUnit(tempUnit, apparentTemp) : null
    const apparentString = this.localize('misc.feels-like')
    const aqiString = this.localize('misc.aqi')

    return html`
      <clock-weather-card-today-left>
        <img class="grow-img" src=${icon} />
      </clock-weather-card-today-left>
      <clock-weather-card-today-temp>
        ${localizedTemp ?? 'n/a'}
        ${temp !== null ? this.renderTemperatureTrendIcon() : ''}
      </clock-weather-card-today-temp>
      <clock-weather-card-today-right>
        <clock-weather-card-today-right-wrap-top>
          ${weatherString}
          ${this.config.show_humidity && localizedHumidity ? html`<br>${localizedHumidity}` : ''}
          ${this.config.apparent_sensor && apparentTemp ? html`<br>${apparentString}: ${localizedApparent}` : ''}
          ${this.config.aqi_sensor && aqi !== null ? html`<br><aqi style="background-color: ${aqiBackgroundColor}; color: ${aqiTextColor};">${aqi} ${aqiString}</aqi>` : ''}
          ${this.config.wind_speed && windInfo ? html`<br>${windInfo}` : ''}
        </clock-weather-card-today-right-wrap-top>
        <clock-weather-card-today-right-wrap-bottom>
          ${this.config.hide_clock ? '' : this.time()}
          ${this.config.hide_date ? '' : html`<br>${this.date()}`}
        </clock-weather-card-today-right-wrap-bottom>
      </clock-weather-card-today-right>`
  }

  private renderForecast (): TemplateResult | TemplateResult[] {
    const weather = this.getWeather()
    const currentTemp = roundIfNotNull(this.getCurrentTemperature())
    const maxRowsCount = this.config.forecast_rows
    const hourly = this.config.hourly_forecast
    const temperatureUnit = weather.attributes.temperature_unit

    // Always use daily forecasts for left side display
    const forecasts = this.getDailySummaryForecasts(maxRowsCount)

    const minTemps = forecasts.map((f) => f.templow)
    const maxTemps = forecasts.map((f) => f.temperature)
    if (currentTemp !== null) {
      minTemps.push(currentTemp)
      maxTemps.push(currentTemp)
    }
    const minTemp = Math.round(min(minTemps))
    const maxTemp = Math.round(max(maxTemps))

    const displayTexts = forecasts
      .map(f => f.datetime)
      .map(d => this.localize(`day.${d.weekday}`))
    const maxColOneChars = displayTexts.length ? max(displayTexts.map(t => t.length)) : 0

    const forecastRows = forecasts.map((forecast, i) => safeRender(() => this.renderForecastItem(forecast, minTemp, maxTemp, currentTemp, displayTexts[i], maxColOneChars, temperatureUnit)))

    if (hourly) {
      const hourlyRows = forecasts.map((forecast, i) => safeRender(() => this.renderHourlyForecastLeftItem(forecast, displayTexts[i], maxColOneChars)))
      const columns = this.cachedHourlyColumns ?? []
      return html`
        <clock-weather-card-hourly-layout>
          <clock-weather-card-hourly-left>
            ${hourlyRows}
          </clock-weather-card-hourly-left>
          <clock-weather-card-hourly-columns style="--row-count: ${forecasts.length};">
            ${columns.map((column) => this.renderHourlyColumn(column))}
          </clock-weather-card-hourly-columns>
        </clock-weather-card-hourly-layout>
      `
    }

    return forecastRows
  }

  private renderForecastItem (forecast: MergedWeatherForecast, minTemp: number, maxTemp: number, currentTemp: number | null, displayText: string, maxColOneChars: number, temperatureUnit: TemperatureUnit): TemplateResult {
    const weatherState = forecast.condition === 'pouring' ? 'raindrops' : forecast.condition === 'rainy' ? 'raindrop' : forecast.condition
    const forecastIconType = this.config.weather_icon_type === 'monochrome' ? 'monochrome' : 'fill'
    const weatherIcon = this.toIcon(weatherState, forecastIconType, true, 'static')
    const tempUnit = this.getWeather().attributes.temperature_unit
    const isNow = DateTime.now().day === forecast.datetime.day
    const minTempDay = Math.round(isNow && currentTemp !== null ? Math.min(currentTemp, forecast.templow) : forecast.templow)
    const maxTempDay = Math.round(isNow && currentTemp !== null ? Math.max(currentTemp, forecast.temperature) : forecast.temperature)

    return html`
      <clock-weather-card-forecast-row style="--col-one-size: ${(maxColOneChars * 0.5)}rem;">
        ${this.renderText(displayText)}
        ${this.renderIcon(weatherIcon)}
        ${this.renderText(this.toConfiguredTempWithUnit(tempUnit, minTempDay), 'right')}
        ${this.renderForecastTemperatureBar(minTemp, maxTemp, minTempDay, maxTempDay, isNow, currentTemp, temperatureUnit)}
        ${this.renderText(this.toConfiguredTempWithUnit(tempUnit, maxTempDay))}
      </clock-weather-card-forecast-row>
    `
  }

  private renderHourlyForecastLeftItem (forecast: MergedWeatherForecast, displayText: string, maxColOneChars: number): TemplateResult {
    const weatherState = forecast.condition === 'pouring' ? 'raindrops' : forecast.condition === 'rainy' ? 'raindrop' : forecast.condition
    const forecastIconType = this.config.weather_icon_type === 'monochrome' ? 'monochrome' : 'fill'
    const weatherIcon = this.toIcon(weatherState, forecastIconType, true, 'static')
    const tempUnit = this.getWeather().attributes.temperature_unit
    const minTempDay = Math.round(forecast.templow)
    const maxTempDay = Math.round(forecast.temperature)
    const lowText = this.toConfiguredTempWithUnit(tempUnit, minTempDay)
    const highText = this.toConfiguredTempWithUnit(tempUnit, maxTempDay)

    return html`
      <clock-weather-card-hourly-left-row style="--col-one-size: ${(maxColOneChars * 0.5)}rem;">
        ${this.renderText(displayText)}
        ${this.renderIcon(weatherIcon)}
        ${this.renderText(`${lowText} / ${highText}`, 'right')}
      </clock-weather-card-hourly-left-row>
    `
  }

  private renderHourlyColumn (column: {
    timeText: string
    tempText: string
    tempColor: string
    barHeightPercent: number
    color: string
    isCurrent: boolean
  }): TemplateResult {
    return html`
      <hourly-forecast-column>
        <hourly-forecast-column-plot>
          <hourly-forecast-column-bar style="--hourly-bar-height: ${column.barHeightPercent}%; --bar-color: ${column.color}; --bar-opacity: ${column.isCurrent ? 0.85 : 1};">
            <hourly-forecast-column-temp-top style="--hourly-temp-color: ${column.tempColor};">
              ${column.tempText}
            </hourly-forecast-column-temp-top>
          </hourly-forecast-column-bar>
        </hourly-forecast-column-plot>
        <hourly-forecast-column-time>${column.timeText}</hourly-forecast-column-time>
      </hourly-forecast-column>
    `
  }

  private renderText (text: string, textAlign: 'left' | 'center' | 'right' = 'left'): TemplateResult {
    return html`
      <forecast-text style="--text-align: ${textAlign};">
        ${text}
      </forecast-text>
    `
  }

  private renderIcon (src: string): TemplateResult {
    return html`
      <forecast-icon>
        <img class="grow-img" src=${src} />
      </forecast-icon>
    `
  }

  private renderTemperatureTrendIcon (): TemplateResult {
    const trend = this.temperatureTrend
    const icon = temperatureTrendIcons[this.config.weather_icon_type][trend]

    return html`
      <img
        class="temperature-trend-icon"
        src=${icon}
        alt=${`Temperature ${trend}`}
      />
    `
  }

  private renderForecastTemperatureBar (minTemp: number, maxTemp: number, minTempDay: number, maxTempDay: number, isNow: boolean, currentTemp: number | null, temperatureUnit: TemperatureUnit): TemplateResult {
    const { startPercent, endPercent } = this.calculateBarRangePercents(minTemp, maxTemp, minTempDay, maxTempDay)
    const moveRight = maxTemp === minTemp ? 0 : (minTempDay - minTemp) / (maxTemp - minTemp)
    const isMonochrome = this.config.weather_icon_type === 'monochrome'
    const rangeStyle = `--move-right: ${moveRight.toFixed(2)}; --start-percent: ${startPercent.toFixed(2)}%; --end-percent: ${endPercent.toFixed(2)}%; --gradient: ${this.createGradientString(
      minTempDay,
      maxTempDay,
      temperatureUnit
    )}; ${isMonochrome ? 'background: var(--card-background-color, var(--ha-card-background, var(--paper-card-background-color, #fff))); border: 2px solid var(--primary-text-color); box-sizing: border-box;' : ''}`
    return html`
      <forecast-temperature-bar>
        ${!isMonochrome ? html`<forecast-temperature-bar-background> </forecast-temperature-bar-background>` : ''}
        <forecast-temperature-bar-range
          style=${rangeStyle}
        >
          ${isNow ? this.renderForecastCurrentTemp(minTempDay, maxTempDay, currentTemp) : ''}
        </forecast-temperature-bar-range>
      </forecast-temperature-bar>
    `
  }

  private renderForecastCurrentTemp (minTempDay: number, maxTempDay: number, currentTemp: number | null): TemplateResult {
    if (currentTemp == null) {
      return html``
    }
    const indicatorPosition = minTempDay === maxTempDay ? 0 : (100 / (maxTempDay - minTempDay)) * (currentTemp - minTempDay)
    const steps = maxTempDay - minTempDay
    const moveRight = maxTempDay === minTempDay ? 0 : (currentTemp - minTempDay) / steps
    return html`
      <forecast-temperature-bar-current-indicator style="--position: ${indicatorPosition}%;">
        <forecast-temperature-bar-current-indicator-dot style="--move-right: ${moveRight}">
        </forecast-temperature-bar-current-indicator-dot>
      </forecast-temperature-bar-current-indicator>
    `
  }

  // https://lit.dev/docs/components/styles/
  static get styles (): CSSResultGroup {
    return styles
  }

  private createGradientString (minTempDay: number, maxTempDay: number, temperatureUnit: TemperatureUnit): string {
    function linearizeColor (temp: number, [tempLeft, colorLeft]: [number, Rgb], [tempRight, colorRight]: [number, Rgb]): Rgb {
      const ratio = Math.max(Math.min((temp - tempLeft) / (tempRight - tempLeft), 1.0), 0.0)
      return new Rgb(
        Math.round(colorLeft.r + ratio * (colorRight.r - colorLeft.r)),
        Math.round(colorLeft.g + ratio * (colorRight.g - colorLeft.g)),
        Math.round(colorLeft.b + ratio * (colorRight.b - colorLeft.b))
      )
    }

    const minTempDayCelsius = this.toCelsius(temperatureUnit, minTempDay)
    const maxTempDayCelsius = this.toCelsius(temperatureUnit, maxTempDay)

    if (minTempDayCelsius === maxTempDayCelsius) {
      const entries = [...gradientMap.entries()]
      let color: Rgb
      if (minTempDayCelsius <= entries[0][0]) {
        color = entries[0][1]
      } else if (minTempDayCelsius >= entries[entries.length - 1][0]) {
        color = entries[entries.length - 1][1]
      } else {
        const upperIndex = entries.findIndex(([temp]) => temp >= minTempDayCelsius)
        color = linearizeColor(minTempDayCelsius, entries[upperIndex - 1], entries[upperIndex])
      }
      return `${color.toRgbString()} 0%, ${color.toRgbString()} 100%`
    }

    const outputGradient = ([...gradientMap.entries()]
      .reduce((gradient, [temp, color], index, arr) => {
        if (index === 0) {
          // First color
          // Remark: This if-level can't be optimized away as in the unlikely event
          // that the daily low would be exactly same floating point value than
          // the first color temperature, we would hit negative index on the lower branches.
          if (temp > minTempDayCelsius) {
            // Daily low is lower than lowest color temperature
            // so we have to duplicate.
            gradient.set(0.0, color)
            gradient.set((temp - minTempDayCelsius) / (maxTempDayCelsius - minTempDayCelsius), color)
          } else {
            // Temp is smaller or equal than daily low so we'll skip the color until we know what we need to linearize.
          }
        } else if (temp < minTempDayCelsius) {
          // Still haven't found a color that would be the first one

        } else if (!gradient.has(0.0)) {
          // This is the first color usable color, we need to linearize the color with the previous one
          gradient.set(0.0, linearizeColor(minTempDayCelsius, arr[index - 1], [temp, color]))

          // and then add this color to the right position
          if (temp > maxTempDayCelsius) {
            // This color is also higher than the daily max so we need to linearize it as well
            gradient.set(1.0, linearizeColor(maxTempDayCelsius, arr[index - 1], [temp, color]))
          } else {
            // In other cases (> 0.0 and <= 1.0) we calculate the position
            gradient.set((temp - minTempDayCelsius) / (maxTempDayCelsius - minTempDayCelsius), color)
          }
        } else if (temp < maxTempDayCelsius) {
          // color is on the gradient
          gradient.set((temp - minTempDayCelsius) / (maxTempDayCelsius - minTempDayCelsius), color)
        } else if (!gradient.has(1.0)) {
          // Last color of the gradient
          if (temp > maxTempDayCelsius) {
            // Linearize the last color
            gradient.set(1.0, linearizeColor(maxTempDayCelsius, arr[index - 1], [temp, color]))
          } else {
            // Get last color from the color temperature
            gradient.set(1.0, color)
          }
        } else {
          // We don't care for intermediate colors that are not on the daily gradient
        }

        return gradient
      }, new Map<number, Rgb>())
    )

    // Gradient endpoint check
    if (!outputGradient.has(1.0)) {
      // Gradient is missing the final color. This means that the daily max is higher
      // than highest color temperature so we have to duplicate.
      outputGradient.set(1.0, Array.from(outputGradient.values()).slice(-1)[0])
    }

    // Make the gradient string
    return ([...outputGradient.entries()]
      .map(([pos, color]) => `${color.toRgbString()} ${Math.round(pos * 100.0)}%`)
      .join(', ')
    )
  }

  private handleAction (ev: ActionHandlerEvent): void {
    if (this.hass && this.config && ev.detail.action) {
      handleAction(this, this.hass, this.config, ev.detail.action)
    }
  }

  private mergeConfig (config: ClockWeatherCardConfig): MergedClockWeatherCardConfig {
    return {
      ...config,
      sun_entity: config.sun_entity ?? 'sun.sun',
      temperature_sensor: config.temperature_sensor,
      humidity_sensor: config.humidity_sensor,
      weather_icon_type: config.weather_icon_type ?? 'line',
      forecast_rows: config.forecast_rows ?? 5,
      hourly_columns: config.hourly_columns ?? 12,
      hourly_forecast: config.hourly_forecast ?? false,
      animated_icon: config.animated_icon ?? true,
      time_format: config.time_format?.toString() as '12' | '24' | undefined,
      time_pattern: config.time_pattern ?? undefined,
      show_humidity: config.show_humidity ?? false,
      wind_speed: config.wind_speed ?? false,
      hide_forecast_section: config.hide_forecast_section ?? false,
      hide_today_section: config.hide_today_section ?? false,
      hide_clock: config.hide_clock ?? false,
      hide_date: config.hide_date ?? false,
      date_pattern: config.date_pattern ?? 'D',
      use_browser_time: config.use_browser_time ?? false,
      time_zone: config.time_zone ?? undefined,
      show_decimal: config.show_decimal ?? false,
      apparent_sensor: config.apparent_sensor ?? undefined,
      aqi_sensor: config.aqi_sensor ?? undefined
    }
  }

  private toIcon (weatherState: string, type: 'fill' | 'line' | 'monochrome', forceDay: boolean, kind: 'static' | 'animated'): string {
    const daytime = forceDay ? 'day' : this.getSun()?.state === 'below_horizon' ? 'night' : 'day'

    if (kind === 'static' || type === 'monochrome') {
      const icon = staticIcons[type][weatherState]
      return icon?.[daytime] || icon
    }

    const animatedIcon = animatedIcons[type][weatherState]
    const staticIcon = staticIcons[type][weatherState]
    const icon = animatedIcon ?? staticIcon
    return icon?.[daytime] || icon
  }

  private getWeather (): Weather {
    const weather = this.hass.states[this.config.entity] as unknown as Weather | undefined
    if (!weather) {
      throw this.createError(`Weather entity "${this.config.entity}" could not be found.`)
    }
    return weather
  }

  private getCurrentTemperature (): number | null {
    if (this.config.temperature_sensor) {
      const temperatureSensor = this.hass.states[this.config.temperature_sensor] as TemperatureSensor | undefined
      const temp = temperatureSensor?.state ? parseFloat(temperatureSensor.state) : undefined
      const unit = temperatureSensor?.attributes.unit_of_measurement ?? this.getConfiguredTemperatureUnit()
      if (temp !== undefined && !isNaN(temp)) {
        return this.toConfiguredTempWithoutUnit(unit, temp)
      }
    }

    // return weather temperature if above code could not extract temperature from temperature_sensor
    return this.getWeather().attributes.temperature ?? null
  }

  private async updateTemperatureTrend (): Promise<void> {
    this.temperatureTrend = await this.resolveTemperatureTrend()
  }

  private async resolveTemperatureTrend (): Promise<TemperatureTrend> {
    const now = this.toZonedDate(this.currentDate).startOf('hour')
    const weatherTemperatureUnit = this.getWeather().attributes.temperature_unit
    const hourKey = (date: DateTime): string => this.toZonedDate(date).startOf('hour').toFormat('yyyy-LL-dd-HH')

    const temperatureByHour = new Map<string, number>()

    const historicalTemps = await this.getHistoricalTemperatures(2, weatherTemperatureUnit)
    for (const [key, temp] of historicalTemps) {
      temperatureByHour.set(key, temp)
    }

    const surroundingForecasts = this.getSurroundingHourlyForecasts(0, 2)
    for (const forecast of surroundingForecasts) {
      if (forecast.temperature === null) continue
      const key = hourKey(this.parseDateTime(forecast.datetime))
      temperatureByHour.set(key, forecast.temperature)
    }

    const temperatures = [-2, -1, 0, 1, 2]
      .map((offset) => temperatureByHour.get(hourKey(now.plus({ hours: offset })) ?? '') ?? null)
      .filter((temperature): temperature is number => temperature !== null)

    if (temperatures.length < 2) {
      return 'stable'
    }

    const threshold = this.config.show_decimal ? 0.1 : 0.5
    const firstTemperature = temperatures[0]
    const lastTemperature = temperatures[temperatures.length - 1]
    const minTemperature = min(temperatures)
    const maxTemperature = max(temperatures)

    if ((maxTemperature - minTemperature) <= threshold) {
      return 'stable'
    }

    const isRising = temperatures.every((temperature, index) => index === 0 || temperature >= (temperatures[index - 1] - threshold))
    const isFalling = temperatures.every((temperature, index) => index === 0 || temperature <= (temperatures[index - 1] + threshold))

    if (isRising && (lastTemperature - firstTemperature) > threshold) {
      return 'rising'
    }

    if (isFalling && (firstTemperature - lastTemperature) > threshold) {
      return 'falling'
    }

    if ((lastTemperature - firstTemperature) > threshold) {
      return 'rising'
    }

    if ((firstTemperature - lastTemperature) > threshold) {
      return 'falling'
    }

    return 'stable'
  }

  private getSurroundingHourlyForecasts (previousHours: number, nextHours: number): WeatherForecast[] {
    const now = this.toZonedDate(this.currentDate)
    const windowStart = now.minus({ hours: previousHours })
    const windowEnd = now.plus({ hours: nextHours })

    return (this.hourlyForecasts ?? [])
      .filter((forecast) => forecast.temperature !== null)
      .map((forecast) => ({
        forecast,
        datetime: this.parseDateTime(forecast.datetime).setZone(now.zoneName ?? undefined)
      }))
      .filter(({ datetime }) => datetime.toMillis() >= windowStart.toMillis() && datetime.toMillis() <= windowEnd.toMillis())
      .sort((left, right) => left.datetime.toMillis() - right.datetime.toMillis())
      .map(({ forecast }) => forecast)
  }

  private convertTemperatureBetweenUnits (temperature: number, fromUnit: TemperatureUnit, toUnit: TemperatureUnit): number {
    if (fromUnit === toUnit) {
      return temperature
    }

    return toUnit === '°C'
      ? this.toCelsius(fromUnit, temperature)
      : this.toFahrenheit(fromUnit, temperature)
  }

  private getHistoricalTemperatureSources (): string[] {
    const weatherEntityId = this.config.entity
    if (this.config.temperature_sensor) {
      return [this.config.temperature_sensor]
    }

    return [weatherEntityId]
  }

  private async getHistoricalTemperatures (previousHours: number, targetUnit: TemperatureUnit): Promise<Map<string, number>> {
    const now = this.toZonedDate(this.currentDate).startOf('hour')
    const startTime = now.minus({ hours: previousHours })
    return await this.getHistoricalTemperaturesByHour(startTime, now, targetUnit)
  }

  private async getHistoricalTemperaturesByHour (
    startTime: DateTime,
    endTime: DateTime,
    targetUnit: TemperatureUnit
  ): Promise<Map<string, number>> {
    try {
      const cacheStart = this.toZonedDate(startTime).startOf('hour')
      const cacheEnd = this.toZonedDate(endTime).startOf('hour')
      const sourceEntity = this.config.temperature_sensor ?? this.config.entity
      const cacheKey = `${cacheStart.toFormat('yyyy-LL-dd-HH')}-${cacheEnd.toFormat('yyyy-LL-dd-HH')}-${targetUnit}-${sourceEntity}`

      const cached = this.historicalTemperatureCache.get(cacheKey)
      if (cached) {
        return new Map(cached)
      }

      const temperatureByHour = new Map<string, number>()
      const hourKey = (dateIso: string): string => this.toZonedDate(this.parseDateTime(dateIso)).startOf('hour').toFormat('yyyy-LL-dd-HH')
      const historyStart = startTime.minus({ hours: 12 })

      // Prefer recorder statistics for modern measurement sensors.
      if (this.config.temperature_sensor) {
        const statisticsByHour = await this.getHistoricalTemperaturesFromStatistics(this.config.temperature_sensor, startTime, endTime, targetUnit)
        if (statisticsByHour.size > 0) {
          return statisticsByHour
        }
      }

      const sourceEntities = this.getHistoricalTemperatureSources()
      for (const sourceEntity of sourceEntities) {
        const historyResponse = await this.fetchHistoryDuringPeriod(sourceEntity, historyStart, endTime)

        const historyEntries = this.extractHistoryEntries(historyResponse, sourceEntity)
        const points: Array<{ timestamp: number, temperature: number }> = []
        for (const entry of historyEntries) {
          if (entry.state === 'unknown' || entry.state === 'unavailable') {
            continue
          }

          const fromState = parseFloat(entry.state)
          const rawTemp = !isNaN(fromState)
            ? fromState
            : entry.attributes?.temperature

          if (rawTemp !== undefined && rawTemp !== null) {
            const sourceUnit = entry.attributes?.unit_of_measurement === '°F' || entry.attributes?.temperature_unit === '°F'
              ? '°F'
              : entry.attributes?.unit_of_measurement === '°C' || entry.attributes?.temperature_unit === '°C'
                ? '°C'
                : targetUnit
            const normalizedTemp = this.convertTemperatureBetweenUnits(rawTemp, sourceUnit, targetUnit)
            const timestampIso = entry.last_updated ?? entry.last_changed
            const timestamp = this.parseDateTime(timestampIso).toMillis()
            if (!isNaN(timestamp)) {
              points.push({ timestamp, temperature: normalizedTemp })
            }
          }
        }

        points.sort((a, b) => a.timestamp - b.timestamp)
        let pointIndex = 0
        let latestTemp: number | null = null
        for (let bucket = startTime; bucket.toMillis() <= endTime.toMillis(); bucket = bucket.plus({ hours: 1 })) {
          const bucketEnd = bucket.endOf('hour').toMillis()
          while (pointIndex < points.length && points[pointIndex].timestamp <= bucketEnd) {
            latestTemp = points[pointIndex].temperature
            pointIndex += 1
          }

          if (latestTemp !== null) {
            const key = hourKey(bucket.toISO() ?? '')
            if (!temperatureByHour.has(key)) {
              temperatureByHour.set(key, latestTemp)
            }
          }
        }
      }

      this.historicalTemperatureCache.set(cacheKey, new Map(temperatureByHour))
      if (this.historicalTemperatureCache.size > 24) {
        const oldestKey = this.historicalTemperatureCache.keys().next().value
        if (oldestKey !== undefined) {
          this.historicalTemperatureCache.delete(oldestKey)
        }
      }

      return temperatureByHour
    } catch (e: unknown) {
      console.warn('clock-weather-card - Error fetching historical temperatures', e)
      return new Map()
    }
  }

  private async getTodayHistoricalMinTemperature (targetUnit: TemperatureUnit): Promise<number | null> {
    try {
      const now = this.toZonedDate(this.currentDate).startOf('hour')
      const startOfDay = now.startOf('day')

      if (startOfDay.toMillis() > now.toMillis()) {
        return null
      }

      const historyByHour = await this.getHistoricalTemperaturesByHour(startOfDay, now, targetUnit)
      const temperatures = Array.from(historyByHour.values())
      return temperatures.length > 0 ? min(temperatures) : null
    } catch (e: unknown) {
      console.warn('clock-weather-card - Error fetching today historical minimum temperature', e)
      return null
    }
  }

  private async fetchHistoryDuringPeriod (
    sourceEntity: string,
    startTime: DateTime,
    endTime: DateTime
  ): Promise<Array<Array<{
      state: string
      last_changed: string
      last_updated?: string
      attributes?: {
        temperature?: number
        unit_of_measurement?: string
        temperature_unit?: string
      }
    }>> | Record<string, Array<{
      state: string
      last_changed: string
      last_updated?: string
      attributes?: {
        temperature?: number
        unit_of_measurement?: string
        temperature_unit?: string
      }
    }>> | null> {
    return await this.hass.callWS<Array<Array<{
      state: string
      last_changed: string
      last_updated?: string
      attributes?: {
        temperature?: number
        unit_of_measurement?: string
        temperature_unit?: string
      }
    }>>>({
      type: 'history/history_during_period',
      start_time: startTime.toISO(),
      end_time: endTime.toISO(),
      entity_ids: [sourceEntity],
      no_attributes: false,
      minimal_response: false
    }).catch(async () => {
      // Compatibility fallback for older/newer HA variants that expect filter_entity_id.
      return await this.hass.callWS<Array<Array<{
        state: string
        last_changed: string
        last_updated?: string
        attributes?: {
          temperature?: number
          unit_of_measurement?: string
          temperature_unit?: string
        }
      }>>>({
        type: 'history/history_during_period',
        start_time: startTime.toISO(),
        end_time: endTime.toISO(),
        filter_entity_id: sourceEntity,
        no_attributes: false,
        minimal_response: false
      }).catch(async () => {
        return await this.hass.callWS<Array<Array<{
          state: string
          last_changed: string
          last_updated?: string
          attributes?: {
            temperature?: number
            unit_of_measurement?: string
            temperature_unit?: string
          }
        }>>>({
          type: 'history/history_during_period',
          start_time: startTime.toISO(),
          end_time: endTime.toISO(),
          entity_id: sourceEntity,
          no_attributes: false,
          minimal_response: false
        }).catch(() => null)
      })
    })
  }

  private async getHistoricalTemperaturesFromStatistics (
    statisticId: string,
    startTime: DateTime,
    endTime: DateTime,
    targetUnit: TemperatureUnit
  ): Promise<Map<string, number>> {
    interface StatisticsEntry {
      start: string
      mean?: number | null
      state?: number | string | null
      max?: number | null
      min?: number | null
    }

    try {
      const statisticsResponse = await this.hass.callWS<Record<string, StatisticsEntry[]>>({
        type: 'recorder/statistics_during_period',
        start_time: startTime.toISO(),
        end_time: endTime.plus({ hours: 1 }).toISO(),
        statistic_ids: [statisticId],
        period: 'hour'
      }).catch(() => null)

      const entries = statisticsResponse?.[statisticId] ?? []
      if (!entries.length) {
        return new Map()
      }

      const sourceState = this.hass.states[statisticId] as TemperatureSensor | undefined
      const sourceUnit = sourceState?.attributes.unit_of_measurement === '°F' ? '°F' : sourceState?.attributes.unit_of_measurement === '°C' ? '°C' : targetUnit
      const points: Array<{ timestamp: number, temperature: number }> = []

      for (const entry of entries) {
        const candidateValues = [
          entry.mean,
          typeof entry.state === 'number' ? entry.state : (entry.state ? parseFloat(entry.state) : null),
          entry.max,
          entry.min
        ]
        const raw = candidateValues.find((value): value is number => value !== null && value !== undefined && !isNaN(value))
        if (raw === undefined) {
          continue
        }

        const timestamp = this.parseDateTime(entry.start).toMillis()
        if (!isNaN(timestamp)) {
          points.push({
            timestamp,
            temperature: this.convertTemperatureBetweenUnits(raw, sourceUnit, targetUnit)
          })
        }
      }

      points.sort((a, b) => a.timestamp - b.timestamp)
      const byHour = new Map<string, number>()
      let pointIndex = 0
      let latestTemp: number | null = null
      for (let bucket = startTime; bucket.toMillis() <= endTime.toMillis(); bucket = bucket.plus({ hours: 1 })) {
        const bucketEnd = bucket.endOf('hour').toMillis()
        while (pointIndex < points.length && points[pointIndex].timestamp <= bucketEnd) {
          latestTemp = points[pointIndex].temperature
          pointIndex += 1
        }

        if (latestTemp !== null) {
          const key = this.toZonedDate(bucket).startOf('hour').toFormat('yyyy-LL-dd-HH')
          byHour.set(key, latestTemp)
        }
      }

      return byHour
    } catch (e: unknown) {
      console.warn('clock-weather-card - Error fetching historical temperatures from statistics', e)
      return new Map()
    }
  }

  private extractHistoryEntries (
    historyResponse: Array<Array<{ state: string, last_changed: string, last_updated?: string, attributes?: { temperature?: number, unit_of_measurement?: string, temperature_unit?: string } }>> | Record<string, Array<{ state: string, last_changed: string, last_updated?: string, attributes?: { temperature?: number, unit_of_measurement?: string, temperature_unit?: string } }>> | null,
    sourceEntity: string
  ): Array<{ state: string, last_changed: string, last_updated?: string, attributes?: { temperature?: number, unit_of_measurement?: string, temperature_unit?: string } }> {
    if (!historyResponse) {
      return []
    }

    if (Array.isArray(historyResponse)) {
      const first = historyResponse[0]
      return Array.isArray(first) ? first : []
    }

    return historyResponse[sourceEntity] ?? []
  }

  private getCurrentHumidity (): number | null {
    if (this.config.humidity_sensor) {
      const humiditySensor = this.hass.states[this.config.humidity_sensor] as HumiditySensor | undefined
      const humid = humiditySensor?.state ? parseFloat(humiditySensor.state) : undefined
      if (humid !== undefined && !isNaN(humid)) {
        return humid
      }
    }

    // Return weather humidity if the code could not extract humidity from the humidity_sensor
    return this.getWeather().attributes.humidity ?? null
  }

  private getApparentTemperature (): number | null {
    if (this.config.apparent_sensor) {
      const apparentSensor = this.hass.states[this.config.apparent_sensor] as TemperatureSensor | undefined
      const temp = apparentSensor?.state ? parseFloat(apparentSensor.state) : undefined
      const unit = apparentSensor?.attributes.unit_of_measurement ?? this.getConfiguredTemperatureUnit()
      if (temp !== undefined && !isNaN(temp)) {
        return this.toConfiguredTempWithoutUnit(unit, temp)
      }
    }
    return null
  }

  private getAqi (): number | null {
    if (this.config.aqi_sensor) {
      const aqiSensor = this.hass.states[this.config.aqi_sensor] as HassEntity | undefined
      const aqi = aqiSensor?.state ? parseInt(aqiSensor.state) : undefined
      if (aqi !== undefined && !isNaN(aqi)) {
        return aqi
      }
    }
    return null
  }

  private getWindInfo (): string | null {
    const weather = this.getWeather()
    const windSpeed = weather.attributes.wind_speed
    const windGust = weather.attributes.wind_gust_speed
    const windUnit = weather.attributes.wind_speed_unit ?? ''
    const windBearing = weather.attributes.wind_bearing

    if (windSpeed === undefined || windSpeed === null) {
      return null
    }

    // Format wind speed / gust
    let windDisplay = ''
    if (windSpeed !== undefined && windSpeed !== null) {
      windDisplay = this.config.show_decimal ? windSpeed.toString() : Math.round(windSpeed).toString()
    }

    if (windGust !== undefined && windGust !== null) {
      const gustValue = this.config.show_decimal ? windGust.toString() : Math.round(windGust).toString()
      windDisplay = `${windDisplay} / ${gustValue}`
    }

    // Add unit and bearing
    if (windDisplay) {
      windDisplay += ` ${windUnit}`
      const direction = windBearingToDirection(windBearing)
      if (direction) {
        windDisplay += ` ${direction}`
      }
      windDisplay = `Wind ${windDisplay}`
    }

    return windDisplay || null
  }

  private getAqiBackgroundColor (aqi: number | null): string | null {
    if (aqi == null) {
      return null
    }
    if (aqi <= 50) return '#00FF00'
    if (aqi <= 100) return '#FFFF00'
    if (aqi <= 150) return '#FF8C00'
    if (aqi <= 200) return '#FF0000'
    if (aqi <= 300) return '#9400D3'
    return '#8B0000'
  }

  private getAqiTextColor (aqi: number | null): string {
    // Use black text for light backgrounds (green, yellow, orange) for better readability.
    if (aqi !== null && aqi <= 150) {
      return '#000000'
    }
    // Use white text for dark backgrounds (red, purple, maroon).
    return '#FFFFFF'
  }

  private getSun (): HassEntityBase | undefined {
    return this.hass.states[this.config.sun_entity]
  }

  private getLocale (): string {
    return this.config.locale ?? this.hass.locale.language ?? 'en-GB'
  }

  private date (): string {
    return this.toZonedDate(this.currentDate).toFormat(this.config.date_pattern)
  }

  private time (date: DateTime = this.currentDate): string {
    if (this.config.time_pattern) {
      return this.toZonedDate(date).toFormat(this.config.time_pattern)
    }

    if (this.config.time_format) {
      return this.toZonedDate(date)
        .toFormat(this.config.time_format === '24' ? 'HH:mm' : 'h:mm a')
    }
    if (this.hass.locale.time_format === TimeFormat.am_pm) {
      return this.toZonedDate(date).toFormat('h:mm a')
    }

    if (this.hass.locale.time_format === TimeFormat.twenty_four) {
      return this.toZonedDate(date).toFormat('HH:mm')
    }

    return this.toZonedDate(date).toFormat('t')
  }

  private getIconAnimationKind (): 'static' | 'animated' {
    return this.config.animated_icon ? 'animated' : 'static'
  }

  private toCelsius (temperatueUnit: TemperatureUnit, temperature: number): number {
    return temperatueUnit === '°C' ? temperature : Math.round((temperature - 32) * (5 / 9))
  }

  private toFahrenheit (temperatueUnit: TemperatureUnit, temperature: number): number {
    return temperatueUnit === '°F' ? temperature : Math.round((temperature * 9 / 5) + 32)
  }

  private getConfiguredTemperatureUnit (): TemperatureUnit {
    return this.hass.config.unit_system.temperature as TemperatureUnit
  }

  private toConfiguredTempWithUnit (unit: TemperatureUnit, temp: number): string {
    const convertedTemp = this.toConfiguredTempWithoutUnit(unit, temp)
    return convertedTemp + this.getConfiguredTemperatureUnit()
  }

  private toConfiguredTempWithoutUnit (unit: TemperatureUnit, temp: number): number {
    const configuredUnit = this.getConfiguredTemperatureUnit()
    if (configuredUnit === unit) {
      return temp
    }

    return unit === '°C'
      ? this.toFahrenheit(unit, temp)
      : this.toCelsius(unit, temp)
  }

  private calculateBarRangePercents (minTemp: number, maxTemp: number, minTempDay: number, maxTempDay: number): { startPercent: number, endPercent: number } {
    if (maxTemp === minTemp) {
      // avoid division by 0
      return { startPercent: 0, endPercent: 100 }
    }
    const startPercent = (100 / (maxTemp - minTemp)) * (minTempDay - minTemp)
    const endPercent = (100 / (maxTemp - minTemp)) * (maxTempDay - minTemp)
    // fix floating point issue
    // (100 / (19 - 8)) * (19 - 8) = 100.00000000000001
    return {
      startPercent: Math.max(0, startPercent),
      endPercent: Math.min(100, endPercent)
    }
  }

  private localize (key: string): string {
    return localize(key, this.getLocale())
  }

  private formatHourlyColumnHour (date: DateTime): string {
    const use24Hour = this.config.time_format === '24' || (this.config.time_format == null && this.hass.locale.time_format === TimeFormat.twenty_four)
    return this.toZonedDate(date).toFormat(use24Hour ? 'H' : 'h')
  }

  private async getHourlyColumns (columnsCount: number, temperatureUnit: TemperatureUnit): Promise<Array<{
    timeText: string
    tempText: string
    tempColor: string
    barHeightPercent: number
    color: string
    isCurrent: boolean
  }>> {
    const now = this.toZonedDate(this.currentDate).startOf('hour')
    const previousHours = Math.min(4, Math.floor(columnsCount * 0.25))
    const nextHours = Math.max(0, columnsCount - previousHours - 1)
    const start = now.minus({ hours: previousHours })

    const hourKey = (date: DateTime): string => this.toZonedDate(date).startOf('hour').toFormat('yyyy-LL-dd-HH')

    // Collect hourly data in the visible window and map by local hour bucket.
    const temperatureByHour = new Map<string, number>()

    // Fetch historical temperatures for previous hours
    const historicalTemps = await this.getHistoricalTemperatures(previousHours, temperatureUnit)
    for (const [key, temp] of historicalTemps) {
      temperatureByHour.set(key, temp)
    }

    // Fetch forecast data for current hour forward
    const allHourlyData = this.getSurroundingHourlyForecasts(previousHours, nextHours)
    for (const forecast of allHourlyData) {
      if (forecast.temperature === null) continue
      const parsed = this.parseDateTime(forecast.datetime)
      temperatureByHour.set(hourKey(parsed), forecast.temperature)
    }

    // Ensure the current hour always uses the live current temperature value.
    const currentTemperature = this.getCurrentTemperature()
    if (currentTemperature !== null) {
      const currentTemperatureUnit = this.config.temperature_sensor ? this.getConfiguredTemperatureUnit() : temperatureUnit
      const currentTempInForecastUnit = this.convertTemperatureBetweenUnits(currentTemperature, currentTemperatureUnit, temperatureUnit)
      temperatureByHour.set(hourKey(now), currentTempInForecastUnit)
    }

    const hourlyColumns = Array.from({ length: columnsCount }, (_, index) => {
      const date = start.plus({ hours: index })
      const key = hourKey(date)
      const temperature = temperatureByHour.get(key) ?? null
      return {
        hourText: this.formatHourlyColumnHour(date),
        temperature,
        isCurrent: date.toMillis() === now.toMillis()
      }
    })

    const numericTemps = hourlyColumns
      .map((column) => column.temperature)
      .filter((temperature): temperature is number => temperature !== null)
      .map((temperature) => this.toConfiguredTempWithoutUnit(temperatureUnit, temperature))

    const minTemp = numericTemps.length ? min(numericTemps) : 0
    const maxTemp = numericTemps.length ? max(numericTemps) : 1
    const actualRange = maxTemp - minTemp
    // Require a minimum range to ensure the bars don't exaggerate small differences in temperature,
    // and a minimum of 1 to avoid division by 0.
    const displayRange = Math.max(15, actualRange, 1)
    const displayMinTemp = minTemp - ((displayRange - actualRange) / 2)

    return hourlyColumns.map((column) => {
      if (column.temperature === null) {
        return {
          timeText: column.hourText,
          tempText: '--',
          tempColor: '#FFFFFF',
          barHeightPercent: 16,
          color: this.config.weather_icon_type === 'monochrome' ? '#000000' : 'rgba(140, 140, 140, 0.4)',
          isCurrent: column.isCurrent
        }
      }

      const convertedTemp = this.toConfiguredTempWithoutUnit(temperatureUnit, column.temperature)
      const normalized = (convertedTemp - displayMinTemp) / displayRange
      const barHeightPercent = Math.round((normalized * 70) + 25)
      const displayedTemp = this.config.show_decimal ? Math.round(convertedTemp * 10) / 10 : Math.round(convertedTemp)
      const displayTempText = `${this.config.show_decimal ? displayedTemp.toFixed(1).replace(/\.0$/, '') : displayedTemp.toString()}°`
      const barColor = this.getHourlyColumnColor(column.temperature, temperatureUnit, column.isCurrent)

      return {
        timeText: column.hourText,
        tempText: displayTempText,
        tempColor: this.getHourlyColumnTemperatureTextColor(barColor),
        barHeightPercent,
        color: barColor,
        isCurrent: column.isCurrent
      }
    })
  }

  private getHourlyColumnTemperatureTextColor (barColor: string): string {
    if (this.config.weather_icon_type === 'monochrome') {
      return '#FFFFFF'
    }

    const rgbMatch = barColor.match(/rgb\(\s*([0-9]+),\s*([0-9]+),\s*([0-9]+)\s*\)/i)
    if (!rgbMatch) {
      return '#FFFFFF'
    }

    const red = parseInt(rgbMatch[1], 10)
    const green = parseInt(rgbMatch[2], 10)
    const blue = parseInt(rgbMatch[3], 10)
    const brightness = ((red * 299) + (green * 587) + (blue * 114)) / 1000

    return brightness > 150 ? '#0B1523' : '#FFFFFF'
  }

  private getHourlyColumnColor (temperature: number, unit: TemperatureUnit, isCurrent: boolean): string {
    if (this.config.weather_icon_type === 'monochrome') {
      return isCurrent ? 'rgba(0, 0, 0, 0.5)' : '#000000'
    }

    const tempCelsius = this.toCelsius(unit, temperature)
    const colors = [...gradientMap.entries()].sort(([left], [right]) => left - right)
    if (tempCelsius <= colors[0][0]) {
      return this.darkenRgb(colors[0][1], isCurrent ? 0.72 : 1)
    }
    if (tempCelsius >= colors[colors.length - 1][0]) {
      return this.darkenRgb(colors[colors.length - 1][1], isCurrent ? 0.72 : 1)
    }

    for (let i = 1; i < colors.length; i++) {
      const [rightTemp, rightColor] = colors[i]
      const [leftTemp, leftColor] = colors[i - 1]
      if (tempCelsius <= rightTemp) {
        const ratio = (tempCelsius - leftTemp) / (rightTemp - leftTemp)
        const color = new Rgb(
          Math.round(leftColor.r + ratio * (rightColor.r - leftColor.r)),
          Math.round(leftColor.g + ratio * (rightColor.g - leftColor.g)),
          Math.round(leftColor.b + ratio * (rightColor.b - leftColor.b))
        )
        return this.darkenRgb(color, isCurrent ? 0.72 : 1)
      }
    }

    return this.darkenRgb(colors[colors.length - 1][1], isCurrent ? 0.72 : 1)
  }

  private darkenRgb (color: Rgb, factor: number): string {
    return new Rgb(
      Math.max(0, Math.round(color.r * factor)),
      Math.max(0, Math.round(color.g * factor)),
      Math.max(0, Math.round(color.b * factor))
    ).toRgbString()
  }

  private mergeForecasts (maxRowsCount: number, hourly: boolean): MergedWeatherForecast[] {
    const forecasts = this.isLegacyWeather() ? this.getWeather().attributes.forecast ?? [] : this.forecasts ?? []
    const agg = forecasts.reduce<Record<number, WeatherForecast[]>>((forecasts, forecast) => {
      const d = new Date(forecast.datetime)
      const unit = hourly ? `${d.getMonth()}-${d.getDate()}-${+d.getHours()}` : d.getDate()
      forecasts[unit] = forecasts[unit] || []
      forecasts[unit].push(forecast)
      return forecasts
    }, {})

    return Object.values(agg)
      .reduce((agg: MergedWeatherForecast[], forecasts) => {
        if (forecasts.length === 0) return agg
        const avg = this.calculateAverageForecast(forecasts)
        agg.push(avg)
        return agg
      }, [])
      .sort((a, b) => a.datetime.toMillis() - b.datetime.toMillis())
      .slice(0, maxRowsCount)
  }

  private getDailySummaryForecasts (maxRowsCount: number): MergedWeatherForecast[] {
    const dailyForecasts = this.mergeForecasts(maxRowsCount, false)
    const today = this.toZonedDate(this.currentDate)

    const applyTodayMinFallback = (forecast: MergedWeatherForecast): MergedWeatherForecast => {
      if (this.todayHistoricalMinTemp === null || this.todayHistoricalMinTemp === undefined) {
        return forecast
      }

      const isToday = this.toZonedDate(forecast.datetime).hasSame(today, 'day')
      if (!isToday) {
        return forecast
      }

      return {
        ...forecast,
        templow: this.todayHistoricalMinTemp
      }
    }

    if (!this.supportsFeature(WeatherEntityFeature.FORECAST_TWICE_DAILY) || !this.twiceDailyForecasts?.length) {
      return dailyForecasts.map(applyTodayMinFallback)
    }

    interface TimedForecast {
      forecast: WeatherForecast
      datetime: DateTime
    }

    const sortedTwiceDailyForecasts = this.twiceDailyForecasts
      .map((forecast) => ({
        forecast,
        datetime: this.parseDateTime(forecast.datetime)
      }))
      .sort((a, b) => a.datetime.toMillis() - b.datetime.toMillis())

    const daytimeByDate = new Map<string, { daytime: TimedForecast, precedingNight?: TimedForecast }>()
    let latestNighttime: TimedForecast | undefined

    for (const timedForecast of sortedTwiceDailyForecasts) {
      if (timedForecast.forecast.is_daytime === false) {
        latestNighttime = timedForecast
        continue
      }

      if (timedForecast.forecast.is_daytime !== true) {
        continue
      }

      const dateKey = this.toZonedDate(timedForecast.datetime).toFormat('yyyy-LL-dd')
      if (!daytimeByDate.has(dateKey)) {
        daytimeByDate.set(dateKey, { daytime: timedForecast, precedingNight: latestNighttime })
      }
    }

    return dailyForecasts.map((dailyForecast) => {
      const dateKey = this.toZonedDate(dailyForecast.datetime).toFormat('yyyy-LL-dd')
      const twiceDailyPair = daytimeByDate.get(dateKey)
      if (!twiceDailyPair) {
        return dailyForecast
      }

      const daytimeTemp = twiceDailyPair.daytime.forecast.temperature
      const precedingNightTemp = twiceDailyPair.precedingNight?.forecast.temperature ?? null
      const hasNightAndDayTemps = daytimeTemp !== null && precedingNightTemp !== null

      const fallbackForecast = applyTodayMinFallback(dailyForecast)

      return {
        ...fallbackForecast,
        // Use the daytime condition for the daily summary icon when available.
        condition: twiceDailyPair.daytime.forecast.condition ?? fallbackForecast.condition,
        temperature: hasNightAndDayTemps ? daytimeTemp : fallbackForecast.temperature,
        templow: hasNightAndDayTemps ? precedingNightTemp : fallbackForecast.templow
      }
    })
  }

  private toZonedDate (date: DateTime): DateTime {
    const localizedDate = date.setLocale(this.getLocale())
    if (this.config.use_browser_time) return localizedDate
    const timeZone = this.config.time_zone ?? this.hass?.config?.time_zone
    const withTimeZone = localizedDate.setZone(timeZone)
    if (withTimeZone.isValid) {
      return withTimeZone
    }
    console.error(`clock-weather-card - Time Zone [${timeZone}] not supported. Falling back to browser time.`)
    return localizedDate
  }

  private calculateAverageForecast (forecasts: WeatherForecast[]): MergedWeatherForecast {
    const minTemps = forecasts.map((f) => f.templow ?? f.temperature ?? this.getCurrentTemperature() ?? 0)
    const minTemp = min(minTemps)

    const maxTemps = forecasts.map((f) => f.temperature ?? this.getCurrentTemperature() ?? 0)
    const maxTemp = max(maxTemps)

    const precipitationProbabilities = forecasts.map((f) => f.precipitation_probability ?? 0)
    const precipitationProbability = max(precipitationProbabilities)

    const precipitations = forecasts.map((f) => f.precipitation ?? 0)
    const precipitation = max(precipitations)

    const conditions = forecasts.map((f) => f.condition)
    const condition = extractMostOccuring(conditions)

    return {
      temperature: maxTemp,
      templow: minTemp,
      datetime: this.parseDateTime(forecasts[0].datetime),
      condition,
      precipitation_probability: precipitationProbability,
      precipitation
    }
  }

  private async subscribeForecastEvents (): Promise<void> {
    if (this.forecastSubscriberLock) {
      return
    }
    this.forecastSubscriberLock = true
    await this.unsubscribeForecastEvents()
    if (this.isLegacyWeather()) {
      this.forecastSubscriber = async () => {}
      this.forecastSubscriberLock = false
      return
    }

    if (!this.isConnected || !this.config || !this.hass) {
      this.forecastSubscriberLock = false
      return
    }

    const forecastType = this.determineForecastType()
    if (forecastType === 'hourly_not_supported') {
      this.forecastSubscriber = async () => {}
      this.forecastSubscriberLock = false
      throw this.createError(`Weather entity [${this.config.entity}] does not support hourly forecast.`)
    }
    try {
      const callback = (event: WeatherForecastEvent): void => {
        this.forecasts = event.forecast
      }
      const options = { resubscribe: false }
      const message = {
        type: 'weather/subscribe_forecast',
        forecast_type: forecastType,
        entity_id: this.config.entity
      }
      this.forecastSubscriber = await this.hass.connection.subscribeMessage<WeatherForecastEvent>(callback, message, options)
    } catch (e: unknown) {
      console.error('clock-weather-card - Error when subscribing to weather forecast', e)
    } finally {
      this.forecastSubscriberLock = false
    }
  }

  private async unsubscribeForecastEvents (): Promise<void> {
    if (this.forecastSubscriber) {
      try {
        await this.forecastSubscriber()
      } catch (e: unknown) {
        // swallow error, as this means that connection was closed already
      } finally {
        this.forecastSubscriber = undefined
      }
    }
  }

  private async subscribeTwiceDailyForecastEvents (): Promise<void> {
    if (this.twiceDailyForecastSubscriberLock || this.config == null || this.hass == null) {
      return
    }

    this.twiceDailyForecastSubscriberLock = true
    await this.unsubscribeTwiceDailyForecastEvents()

    if (this.isLegacyWeather() || !this.supportsFeature(WeatherEntityFeature.FORECAST_TWICE_DAILY)) {
      this.twiceDailyForecasts = undefined
      this.twiceDailyForecastSubscriber = async () => {}
      this.twiceDailyForecastSubscriberLock = false
      return
    }

    if (!this.isConnected) {
      this.twiceDailyForecastSubscriberLock = false
      return
    }

    try {
      const callback = (event: WeatherForecastEvent): void => {
        this.twiceDailyForecasts = event.forecast
      }
      const options = { resubscribe: false }
      const message = {
        type: 'weather/subscribe_forecast',
        forecast_type: 'twice_daily' as const,
        entity_id: this.config.entity
      }
      this.twiceDailyForecastSubscriber = await this.hass.connection.subscribeMessage<WeatherForecastEvent>(callback, message, options)
    } catch (e: unknown) {
      console.error('clock-weather-card - Error when subscribing to twice-daily weather forecast', e)
      this.twiceDailyForecasts = undefined
    } finally {
      this.twiceDailyForecastSubscriberLock = false
    }
  }

  private async unsubscribeTwiceDailyForecastEvents (): Promise<void> {
    if (this.twiceDailyForecastSubscriber) {
      try {
        await this.twiceDailyForecastSubscriber()
      } catch (e: unknown) {
        // swallow error, as this means that connection was closed already
      } finally {
        this.twiceDailyForecastSubscriber = undefined
      }
    }
  }

  private async subscribeHourlyForecastEvents (): Promise<void> {
    if (this.hourlyForecastSubscriberLock || this.config == null || this.hass == null) {
      return
    }

    this.hourlyForecastSubscriberLock = true
    await this.unsubscribeHourlyForecastEvents()

    if (this.isLegacyWeather() || !this.supportsFeature(WeatherEntityFeature.FORECAST_HOURLY)) {
      this.hourlyForecasts = undefined
      this.hourlyForecastSubscriber = async () => {}
      this.hourlyForecastSubscriberLock = false
      return
    }

    if (!this.isConnected) {
      this.hourlyForecastSubscriberLock = false
      return
    }

    try {
      const callback = (event: WeatherForecastEvent): void => {
        this.hourlyForecasts = event.forecast
      }
      const options = { resubscribe: false }
      const message = {
        type: 'weather/subscribe_forecast',
        forecast_type: 'hourly' as const,
        entity_id: this.config.entity
      }
      this.hourlyForecastSubscriber = await this.hass.connection.subscribeMessage<WeatherForecastEvent>(callback, message, options)
    } catch (e: unknown) {
      console.error('clock-weather-card - Error when subscribing to hourly weather forecast', e)
      this.hourlyForecasts = undefined
    } finally {
      this.hourlyForecastSubscriberLock = false
    }
  }

  private async unsubscribeHourlyForecastEvents (): Promise<void> {
    if (this.hourlyForecastSubscriber) {
      try {
        await this.hourlyForecastSubscriber()
      } catch (e: unknown) {
        // swallow error, as this means that connection was closed already
      } finally {
        this.hourlyForecastSubscriber = undefined
      }
    }
  }

  private isLegacyWeather (): boolean {
    return !this.supportsFeature(WeatherEntityFeature.FORECAST_DAILY) && !this.supportsFeature(WeatherEntityFeature.FORECAST_HOURLY)
  }

  private supportsFeature (feature: WeatherEntityFeature): boolean {
    try {
      return (this.getWeather().attributes.supported_features & feature) !== 0
    } catch (e) {
      // might be that weather entity was not found
      return false
    }
  }

  private createError (errorString: string): Error {
    const error = new Error(errorString)
    const errorCard = document.createElement('hui-error-card')
    errorCard.setConfig({
      type: 'error',
      error,
      origConfig: this.config
    })
    this.error = html`${errorCard}`
    return error
  }

  private determineForecastType (): 'hourly' | 'daily' | 'hourly_not_supported' {
    const supportsDaily = this.supportsFeature(WeatherEntityFeature.FORECAST_DAILY)
    const supportsHourly = this.supportsFeature(WeatherEntityFeature.FORECAST_HOURLY)
    const hourly = this.config.hourly_forecast
    if (supportsDaily && supportsHourly) {
      return 'daily'
    } else if (hourly && supportsHourly) {
      return 'hourly'
    } else if (!hourly && supportsDaily) {
      return 'daily'
    } else if (hourly && !supportsHourly) {
      return 'hourly_not_supported'
    } else {
      // !hourly && !supportsDaily
      console.warn(`clock-weather-card - Weather entity [${this.config.entity}] does not support daily forecast. Falling back to hourly forecast.`)
      return 'hourly'
    }
  }

  private parseDateTime (date: string): DateTime {
    const fromIso = DateTime.fromISO(date)
    if (fromIso.isValid) {
      return fromIso
    }
    return DateTime.fromJSDate(new Date(date))
  }
}
