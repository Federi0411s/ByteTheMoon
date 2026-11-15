// All the text of the welcome screen, the tutorial and "Learn the basics", in one place so it is
// easy to correct. The `target` of a tutorial step is a CSS selector of the interface element the
// step talks about (highlighted when it is on screen; the card is centred otherwise).

export const INSIGHTS_BUTTON = {
  label: 'Insights',
  title: 'Reopen the welcome screen, the tutorial and the basics',
}

export const WELCOME = {
  title: 'Welcome to ByteTheMoon',
  text:
    'ByteTheMoon helps you explore the lunar south pole and compare candidate landing sites using terrain, ' +
    'illumination, Earth visibility, temperature, surface charging, radiation and water ice data.',
  startTutorial: 'Start tutorial',
  learnBasics: 'Learn the basics',
  skip: 'Skip',
  doNotShowAgain: 'Do not show this again',
}

export interface TutorialStep {
  title: string
  body: string
  /** CSS selector of the element to highlight */
  target?: string
}

export const TUTORIAL = {
  back: 'Back',
  next: 'Next',
  finish: 'Finish',
  close: 'Close',
  steps: [
    {
      title: 'Navigate the Moon',
      body:
        'Drag to rotate, scroll to zoom, Ctrl + drag (or drag with the mouse wheel pressed) to tilt the view. ' +
        'The box in the bottom-right corner shows how much distance 1 cm on screen covers on the Moon.',
      target: '.map-scale',
    },
    {
      title: 'Map layers',
      body:
        'Open Map layers to switch data layers on and off: sunlight, Earth visibility, permanent shadow, slope, ' +
        'elevation, temperature and surface charging. Each layer shows one factor that matters for a safe landing.',
      target: '[data-tour="map-layers"]',
    },
    {
      title: 'Landing suitability',
      body:
        'Show score heatmap combines sunlight, Earth visibility, slope, temperature and radiation into a ' +
        'score from 0 to 100: yellow areas are the most suitable, dark purple the least. The slope alone is in ' +
        'Map layers › Slope.',
      target: '[data-tour="landing-suitability"]',
    },
    {
      title: 'Radiation',
      body:
        'Shows the estimated radiation dose. The Moon has no magnetic field or atmosphere, so cosmic rays (and ' +
        'solar particles during solar storms) reach the ground; nearby crater walls and hills block part of the ' +
        'sky and reduce the dose. Display it as Dose levels (green / yellow / red) or as Continuous dose.',
      target: '[data-tour="radiation"]',
    },
    {
      title: 'Water ice',
      body:
        'Blue points mark cold traps: crater floors so cold (below 110 K, about −163 °C) that water ice is stable ' +
        'at the surface. Ice is a key resource, but it lies in cold, dark craters.',
      target: '[data-tour="water-ice"]',
    },
    {
      title: 'Time',
      body:
        'Use the timeline at the bottom to change the date (tick Sun lighting to see the real illumination), and ' +
        'Mission period on the right to set the dates of your mission: illumination, temperature and Earth ' +
        'visibility change with time.',
      target: '.timebar',
    },
    {
      title: 'Compare sites',
      body:
        'Pick a site in the Landing sites panel, or click any point on the map, to read its values. A good landing ' +
        'site is a compromise: gentle slope, long sunlight, Earth in view for communications, and close to (but not ' +
        'inside) ice-rich craters.',
      target: '#landing-sites-panel',
    },
  ] satisfies TutorialStep[],
}

export const BASICS = {
  title: 'Learn the basics',
  back: 'Back',
  close: 'Close',
  sections: [
    {
      question: 'Why the south pole?',
      answer:
        'Some ridges near the south pole are sunlit for most of the year, which is good for solar power, while ' +
        'nearby craters never see the Sun and can trap water ice for billions of years.',
    },
    {
      question: 'What is a permanently shadowed region (PSR)?',
      answer:
        'A crater floor or depression that never receives direct sunlight because the Sun is always low on the ' +
        'horizon. PSRs are among the coldest places in the Solar System (below about −230 °C).',
    },
    {
      question: 'Why does slope matter?',
      answer:
        'A lander can tip over or fail to land safely on steep terrain, so flat areas (a few degrees of slope) ' +
        'are preferred.',
    },
    {
      question: 'Why must Earth be visible?',
      answer:
        'Without a relay satellite, a lander can only talk to Earth when Earth is above the local horizon. Hills ' +
        'and crater rims can block it.',
    },
    {
      question: 'What is surface charging?',
      answer:
        'Sunlight knocks electrons off the surface and makes it slightly positive; in shadow, electrons from the ' +
        'solar wind charge it negatively, down to about −100 V or more. Strong charging can damage electronics ' +
        'and lift dust.',
    },
    {
      question: 'How cold and hot does it get?',
      answer:
        'Even sunlit polar ridges are cold: they peak at roughly −120 °C to −10 °C and get much colder when ' +
        'shadowed. The darkest crater floors stay around −230 °C or colder all year.',
    },
    {
      question: 'Where do the data come from?',
      answer:
        'NASA LRO: LOLA (topography, long-term sunlight, Earth visibility and permanent shadow), Diviner ' +
        '(temperature and ice stability), LROC (imagery and the lunar pit catalog, Wagner & Robinson 2021). ' +
        'NASA NAIF SPICE with the JPL DE440 ephemeris (Sun and Earth positions). ESA SPENVIS and the EQUIPOT ' +
        'model (surface charging); Chang’e 4 LND measurements (radiation calibration); Hayne et al. 2017 ' +
        '(regolith temperature model). Basemaps: NASA Moon Trek and JAXA Kaguya.',
    },
  ],
}
